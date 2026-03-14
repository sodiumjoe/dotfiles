return {
    "huashuai/nvim-comment-overlay",
    cmd = {
        "CommentAdd", "CommentRefresh", "CommentDelete",
        "CommentEdit", "CommentList", "CommentReply",
        "CommentResolve", "CommentNext", "CommentPrev",
    },
    config = function()
        require("comment-overlay").setup({
            keymaps = {
                add = false, delete = false, edit = false,
                next = false, prev = false,
                toggle_list = false, toggle_global_list = false,
                toggle_signs = false, copy_storage_path = false,
                open_storage = false,
            },
        })
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