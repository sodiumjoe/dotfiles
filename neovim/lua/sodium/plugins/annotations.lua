return {
    "huashuai/nvim-comment-overlay",
    cmd = {
        "CommentAdd", "CommentRefresh", "CommentDelete",
        "CommentEdit", "CommentList", "CommentReply",
        "CommentResolve", "CommentNext", "CommentPrev",
    },
    config = function()
        require("comment-overlay").setup({})
        local default_keymaps = {
            "<leader>ca", "<leader>cd", "<leader>ce",
            "]c", "[c", "<leader>cl", "cL",
            "<leader>cs", "<leader>cy", "<leader>co",
        }
        for _, lhs in ipairs(default_keymaps) do
            pcall(vim.keymap.del, "n", lhs)
        end
        pcall(vim.keymap.del, "v", "<leader>ca")
    end,
    keys = {
        { "<leader>ca", "<cmd>CommentAdd<cr>", mode = { "n", "v" }, desc = "Add annotation" },
        { "<leader>cd", "<cmd>CommentDelete<cr>", desc = "Delete annotation" },
        { "<leader>ce", "<cmd>CommentEdit<cr>", desc = "Edit annotation" },
        { "<leader>cn", "<cmd>CommentNext<cr>", desc = "Next annotation" },
        { "<leader>cp", "<cmd>CommentPrev<cr>", desc = "Previous annotation" },
        { "<leader>cl", "<cmd>CommentList<cr>", desc = "List annotations" },
    },
}