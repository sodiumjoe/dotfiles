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
        vim.keymap.set({ "n", "v" }, "<leader>ca", "<cmd>CommentAdd<cr>", { desc = "Add annotation" })
        vim.keymap.set("n", "<leader>cd", "<cmd>CommentDelete<cr>", { desc = "Delete annotation" })
        vim.keymap.set("n", "<leader>ce", "<cmd>CommentEdit<cr>", { desc = "Edit annotation" })
        vim.keymap.set("n", "<leader>cn", "<cmd>CommentNext<cr>", { desc = "Next annotation" })
        vim.keymap.set("n", "<leader>cp", "<cmd>CommentPrev<cr>", { desc = "Previous annotation" })
        vim.keymap.set("n", "<leader>cl", "<cmd>CommentList<cr>", { desc = "List annotations" })
    end,
    keys = {
        { "<leader>ca", mode = { "n", "v" }, desc = "Add annotation" },
        { "<leader>cd", desc = "Delete annotation" },
        { "<leader>ce", desc = "Edit annotation" },
        { "<leader>cn", desc = "Next annotation" },
        { "<leader>cp", desc = "Previous annotation" },
        { "<leader>cl", desc = "List annotations" },
    },
}