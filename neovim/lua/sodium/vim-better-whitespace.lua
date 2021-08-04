local utils = require("sodium.utils")
require("sodium").highlight("ExtraWhitespace", "Error")

utils.augroup("DisableBetterWhitespace", { "Filetype diff,gitcommit,qf,help,markdown DisableWhitespace" })
