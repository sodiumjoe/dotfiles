local utils = require("sodium.utils")

local M = {}

local active_slots = {}
local spinner_index = 1
local timer

local function refresh()
    local ok, lualine = pcall(require, "lualine")
    if ok then
        lualine.refresh()
    end
end

local function start_timer()
    if timer then
        return
    end
    timer = vim.uv.new_timer()
    if timer == nil then
        return
    end
    timer:start(
        0,
        100,
        vim.schedule_wrap(function()
            if next(active_slots) then
                spinner_index = (spinner_index % #utils.spinner_frames) + 1
                refresh()
            elseif timer then
                spinner_index = 1
                timer:close()
                timer = nil
                refresh()
            end
        end)
    )
end

function M.start(key)
    active_slots[key] = true
    start_timer()
end

function M.stop(key)
    active_slots[key] = nil
end

function M.active(key)
    if key then
        return active_slots[key] == true
    end
    return next(active_slots) ~= nil
end

function M.frame()
    return utils.spinner_frames[spinner_index]
end

return M
