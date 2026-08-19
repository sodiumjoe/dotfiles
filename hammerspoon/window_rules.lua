local M = {}

function M.isYouTubeTitle(title)
    return type(title) == "string" and title:lower():find("youtube", 1, true) ~= nil
end

function M.isYouTubeWindow(win)
    local app = win:application()
    return app and app:name() == "Google Chrome" and M.isYouTubeTitle(win:title())
end

function M.forEachManagedWindow(windows, callback)
    for _, win in ipairs(windows) do
        if not M.isYouTubeWindow(win) then
            callback(win)
        end
    end
end

return M
