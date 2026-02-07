local utils = require("sodium.utils")

local M = {}

function M.setup_js_module_resolution()
    vim.g.path = "."
    vim.o.suffixesadd = ".js"

    vim.api.nvim_exec2(
        [[
  function! LoadMainNodeModule(fname)
    let nodeModules = "./node_modules/"
    let packageJsonPath = nodeModules . a:fname . "/package.json"

    if filereadable(packageJsonPath)
      return nodeModules . a:fname . "/" . json_decode(join(readfile(packageJsonPath))).main
    else
      return nodeModules . a:fname
    endif
  endfunction

  set includeexpr=LoadMainNodeModule(v:fname)
]],
        {}
    )
end

local remote_stripe_dir = "/pay/src/"
local local_stripe_dir = vim.fn.expand("~/stripe/")

local function get_sg_url()
    local stripe_dir = nil
    if vim.fn.isdirectory(remote_stripe_dir) ~= 0 then
        stripe_dir = remote_stripe_dir
    elseif vim.fn.isdirectory(local_stripe_dir) ~= 0 then
        stripe_dir = local_stripe_dir
    end

    local full_path = vim.api.nvim_buf_get_name(0)
    local line_number = vim.fn.line(".")
    if stripe_dir ~= nil and string.find(full_path, stripe_dir) then
        local path_with_repo = string.gsub(full_path, stripe_dir, "")
        local i, j = string.find(path_with_repo, "^.-/")
        local repo = string.sub(path_with_repo, i or 0, j - 1)
        local path = string.sub(path_with_repo, j + 1)
        return string.format(
            [[https://stripe.sourcegraphcloud.com/git.corp.stripe.com/stripe-internal/%s/-/blob/%s?L%s]],
            repo,
            path,
            line_number
        )
    else
        return nil
    end
end

function M.setup_sourcegraph_keymap()
    utils.map({
        {
            "n",
            [[<leader>l]],
            function()
                local sg_url = get_sg_url()
                if sg_url ~= nil then
                    vim.fn.setreg("+", sg_url)
                end
            end,
        },
    })
end

M.setup_js_module_resolution()
M.setup_sourcegraph_keymap()

return M
