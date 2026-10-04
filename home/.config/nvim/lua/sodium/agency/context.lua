local M = {}
local media = {
    png = true,
    jpg = true,
    jpeg = true,
    gif = true,
    webp = true,
    avif = true,
    ico = true,
    svg = true,
    bmp = true,
    tif = true,
    tiff = true,
    pdf = true,
    mp3 = true,
    wav = true,
    ogg = true,
    flac = true,
    mp4 = true,
    mov = true,
    zip = true,
}

local function failure(code)
    return {
        code = code,
        message = code == "INPUT_TOO_LARGE" and "Combined Agency input exceeds 256 KiB"
            or "Agency accepts text context only",
    }
end

local function label(item)
    local path = item.path or item.file_path
    return path and path ~= "" and path or ("[buffer:" .. tostring(item.buffer or item.bufnr or "unnamed") .. "]")
end

local function utf8(value)
    local index = 1
    while index <= #value do
        local start = value:find("[\128-\255]", index)
        if not start then
            return true
        end
        local byte, second = value:byte(start), value:byte(start + 1)
        local length = byte >= 194 and byte <= 223 and 2
            or byte >= 224 and byte <= 239 and 3
            or byte >= 240 and byte <= 244 and 4
            or 0
        if length == 0 or start + length - 1 > #value then
            return false
        end
        if
            (byte == 224 and second < 160)
            or (byte == 237 and second > 159)
            or (byte == 240 and second < 144)
            or (byte == 244 and second > 143)
        then
            return false
        end
        for offset = 1, length - 1 do
            local child = value:byte(start + offset)
            if child < 128 or child > 191 then
                return false
            end
        end
        index = start + length
    end
    return true
end

local function unsupported(item)
    local path = item.path or item.file_path or ""
    local ext = path:match("%.([^./]+)$")
    if item.binary or item.media or (ext and media[ext:lower()]) then
        return true
    end
    for _, line in ipairs(item.lines or {}) do
        if line:find("\0", 1, true) then
            return true
        end
    end
    return false
end

function M.resolve(path)
    local absolute = vim.fs.normalize(vim.fn.fnamemodify(path, ":p")):gsub("/$", "")
    if absolute == "" then
        absolute = "/"
    end
    local suffix, current = {}, absolute
    while current ~= "/" do
        local resolved = vim.uv.fs_realpath(current)
        if resolved then
            return vim.fs.normalize(resolved .. (#suffix > 0 and "/" .. table.concat(suffix, "/") or ""))
        end
        table.insert(suffix, 1, vim.fs.basename(current))
        current = vim.fs.dirname(current)
    end
    return "/" .. table.concat(suffix, "/")
end

function M.inside(cwd, path)
    cwd, path = M.resolve(cwd), M.resolve(path)
    return cwd == "/" or cwd == path or path:sub(1, #cwd + 1) == cwd .. "/"
end

function M.capture(bufnr, mode)
    bufnr = bufnr or vim.api.nvim_get_current_buf()
    local name = vim.api.nvim_buf_get_name(bufnr)
    local captured = {
        buffer = bufnr,
        tab = vim.api.nvim_get_current_tabpage(),
        cwd = vim.fn.getcwd(),
        path = name ~= "" and vim.fn.fnamemodify(name, ":p") or nil,
        lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false),
        modified = vim.bo[bufnr].modified or name == "" or vim.fn.filereadable(name) == 0,
        binary = vim.bo[bufnr].binary,
        file_type = vim.bo[bufnr].filetype,
        diagnostics = {},
    }
    for _, diagnostic in ipairs(vim.diagnostic.get(bufnr)) do
        local value = vim.deepcopy(diagnostic)
        value.file_path = captured.path or ""
        captured.diagnostics[#captured.diagnostics + 1] = value
    end
    if type(mode) == "table" or mode == "v" or mode == "V" then
        local first = type(mode) == "table" and mode.first or vim.fn.getpos("v")[2]
        local last = type(mode) == "table" and mode.last or vim.api.nvim_win_get_cursor(0)[1]
        first, last = math.min(first, last), math.max(first, last)
        captured.selection = {
            buffer = bufnr,
            file_path = captured.path,
            file_type = captured.file_type,
            start_line = first,
            end_line = last,
            lines = vim.api.nvim_buf_get_lines(bufnr, first - 1, last, false),
            binary = captured.binary,
        }
    end
    return captured
end

function M.encode(input, selections, diagnostics, annotations)
    input = type(input) == "string" and { text = input } or input
    local parts = { input.text or "" }
    for _, file in ipairs(input.files or {}) do
        if unsupported(file) then
            return nil, failure("UNSUPPORTED_CONTEXT")
        end
        parts[#parts + 1] = "\nReferenced file: " .. label(file)
        if file.modified then
            parts[#parts + 1] = "Captured unsaved text:\n" .. table.concat(file.lines or {}, "\n")
        end
    end
    for _, selection in ipairs(selections or {}) do
        if unsupported(selection) then
            return nil, failure("UNSUPPORTED_CONTEXT")
        end
        parts[#parts + 1] = string.format(
            "\nSelected code: %s:%d-%d\n%s",
            label(selection),
            selection.start_line,
            selection.end_line,
            table.concat(selection.lines, "\n")
        )
    end
    for _, diagnostic in ipairs(diagnostics or {}) do
        parts[#parts + 1] = string.format(
            "\nDiagnostic: %s:%d:%d\n%s",
            label(diagnostic),
            diagnostic.lnum + 1,
            diagnostic.col + 1,
            diagnostic.message
        )
    end
    if #(annotations or {}) > 0 then
        parts[#parts + 1] = "\nAnnotations:"
        for _, annotation in ipairs(annotations) do
            parts[#parts + 1] = annotation.text
        end
    end
    local text = table.concat(parts, "\n")
    if text:find("\0", 1, true) or not utf8(text) then
        return nil, failure("UNSUPPORTED_CONTEXT")
    end
    if #text > 262144 or #vim.json.encode(text) > 917504 then
        return nil, failure("INPUT_TOO_LARGE")
    end
    if not text:match("%S") then
        return nil, { code = "EMPTY_INPUT", message = "Agency input is empty" }
    end
    return text
end

function M.confirm_external(cwd, items, callback)
    local outside, seen = {}, {}
    for _, item in ipairs(items) do
        local path = item.path or item.file_path
        if path and path ~= "" then
            path = M.resolve(path)
            if not M.inside(cwd, path) and not seen[path] then
                seen[path] = true
                outside[#outside + 1] = path
            end
        end
    end
    if #outside == 0 then
        callback(true)
        return
    end
    vim.ui.select(
        { "Include", "Keep draft" },
        { prompt = "Include outside Agency cwd " .. cwd .. ":\n" .. table.concat(outside, "\n") },
        function(choice)
            callback(choice == "Include")
        end
    )
end

return M