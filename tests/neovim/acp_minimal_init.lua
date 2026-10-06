vim.o.shadafile = "NONE"
vim.opt.rtp:prepend(assert(vim.env.DOTFILES_TEST_ROOT) .. "/home/.config/nvim")
vim.opt.rtp:prepend(assert(vim.env.AGENCY_FIXTURE_PLUGIN_ROOT))
require("agentic").setup({ provider = "agency", acp_providers = {
    agency = { command = assert(vim.env.AGENCY_FIXTURE_NODE), args = { assert(vim.env.AGENCY_FIXTURE_ENDPOINT), assert(vim.env.AGENCY_FIXTURE_CONFIG) } },
}, debug = false })
require("sodium.agency.agentic").install()
dofile(assert(vim.env.DOTFILES_TEST_ROOT) .. "/agency/test/fixtures/acp-neovim.lua")