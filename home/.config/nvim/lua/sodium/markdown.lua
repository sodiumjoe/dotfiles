local M = {}

function M.get_list_prefix(line)
    local indent = line:match("^(%s*)%- %[[ /xX]%] ")
    if indent then
        return indent .. "- [ ] "
    end
    local indent2, marker = line:match("^(%s*)([-*] )")
    if indent2 then
        return indent2 .. marker
    end
    local indent3, num, dot = line:match("^(%s*)(%d+)([.)]) ")
    if indent3 then
        return indent3 .. tostring(tonumber(num) + 1) .. dot .. " "
    end
    return nil
end

function M.has_text_after_prefix(line)
    if line:match("^%s*%- %[.%] ") then
        return line:match("^%s*%- %[.%] .+") ~= nil
    end
    if line:match("^%s*[-*] .+") then return true end
    if line:match("^%s*%d+[.)] .+") then return true end
    return false
end

return M