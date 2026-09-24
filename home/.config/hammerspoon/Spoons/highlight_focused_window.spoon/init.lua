local obj = {}

local borderColor = { red = 1, green = 1, blue = 1, alpha = 0.5 }
local borderWidth = 2
local borderRadius = 18

local focusBorder = nil

local function deleteBorder()
    if focusBorder then
        focusBorder:delete()
        focusBorder = nil
    end
end

local function drawBorder()
    local win = hs.window.frontmostWindow()

    deleteBorder()

    if not win then
        return
    end

    if win:isFullScreen() then
        return
    end

    local frame = win:frame()

    if focusBorder then
        focusBorder:setFrame(frame)
    else
        focusBorder = hs.canvas.new(frame)
        focusBorder[1] = {
            type = "rectangle",
            action = "stroke",
            roundedRectRadii = { xRadius = borderRadius, yRadius = borderRadius },
            strokeColor = borderColor,
            strokeWidth = borderWidth,
        }
        focusBorder:show()
    end
end

hs.window.filter.new():subscribe({
    hs.window.filter.windowFocused,
    hs.window.filter.windowMoved,
    hs.window.filter.windowUnminimized,
    hs.window.filter.windowUnhidden,
    hs.window.filter.windowUnfocused,
    hs.window.filter.windowDestroyed,
    hs.window.filter.windowMinimized,
    hs.window.filter.windowHidden,
}, drawBorder)

return obj
