local root, payload = arg[1], arg[2]
package.path = root .. "/home/.config/nvim/lua/?.lua;" .. root .. "/home/.config/nvim/lua/?/init.lua;" .. package.path
local Control, Roster = require("sodium.agency.control"), require("sodium.agency.roster")
local input = vim.json.decode(table.concat(vim.fn.readfile(payload), "\n"))
local failures = {}
for _, item in ipairs(input.cli) do
    local ok, err = pcall(Control.validate, vim.json.decode(item.output), item.argv)
    if not ok then failures[#failures + 1] = table.concat(item.argv, " ") .. ": " .. tostring(err) end
end
for method, result in pairs(input.acp) do
    local ok, err = pcall(Roster.validators[method], vim.json.decode(result))
    if not ok then failures[#failures + 1] = method .. ": " .. tostring(err) end
end
io.stdout:write(#failures == 0 and "contract ok\n" or table.concat(failures, "\n") .. "\n")
os.exit(#failures == 0 and 0 or 1)