local M = {}

function M.original(target, name)
    local originals = rawget(target, "__sodium_originals")
    if not originals then
        originals = {}
        rawset(target, "__sodium_originals", originals)
    end
    if originals[name] == nil then originals[name] = target[name] end
    return originals[name]
end

function M.claim(target, key, owner)
    local field = "__sodium_owner_" .. key
    if rawget(target, field) == owner then return false end
    rawset(target, field, owner)
    return true
end

return M