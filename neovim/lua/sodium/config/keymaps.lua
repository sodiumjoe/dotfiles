local utils = require("sodium.utils")

utils.map({
    { "n", "j", "gj" },
    { "n", "k", "gk" },
    { "n", [[<leader>cr]], [[:let @+ = expand("%:.")<cr>]] },
    { "n", [[<leader>cf]], [[:let @+ = expand("%:p")<cr>]] },
})
