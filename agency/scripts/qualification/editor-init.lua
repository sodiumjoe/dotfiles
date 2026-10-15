local path = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h") .. "/editor.json"
local c = vim.json.decode(table.concat(vim.fn.readfile(path), "\n"))
vim.opt.runtimepath:prepend(c.luaRoot)
for _, plugin in ipairs(c.plugins) do vim.opt.runtimepath:append(plugin.path) end
local providers = {}
for name in pairs(require("agentic.config_default").acp_providers) do providers[name] = false end
providers.agency = { command = c.launcherPath, args = { "acp" } }
require("agentic").setup({ provider = "agency", acp_providers = providers })
local Control = require("sodium.agency.control")
require("sodium.agency").setup({ client = Control.new({ executable = c.launcherPath }) })