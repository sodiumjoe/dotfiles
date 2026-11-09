local M = {}

local function valid_text(value)
    return type(value) == "string" and vim.trim(value) ~= "" and not value:find("%c")
end

local function names_from(result)
    if result.code ~= 0 then return {} end
    local ok, remotes = pcall(vim.json.decode, result.stdout or "")
    if not ok or type(remotes) ~= "table" or not vim.islist(remotes) then return {} end
    local names = {}
    for _, remote in ipairs(remotes) do
        if type(remote) == "table" and valid_text(remote.host) and valid_text(remote.name) then
            if names[remote.host] and names[remote.host] ~= remote.name then names[remote.host] = false
            elseif names[remote.host] == nil then names[remote.host] = remote.name end
        end
    end
    for host, name in pairs(names) do if name == false then names[host] = nil end end
    return names
end

function M.read(callback)
    local completed, process, deadline = false, nil, nil
    local function finish(names)
        if completed then return end
        completed = true
        if deadline and not deadline:is_closing() then deadline:stop(); deadline:close() end
        callback(names)
    end
    deadline = vim.defer_fn(function()
        if completed then return end
        if process then pcall(process.kill, process, 9) end
        finish({})
    end, 3000)
    local ok, child = pcall(vim.system, { "pay", "remote", "list", "--raw" }, { text = true },
        vim.schedule_wrap(function(result) if not completed then finish(names_from(result)) end end))
    if ok then process = child else finish({}) end
end

return M