hs.window.animationDuration = 0.01
hs.grid.setMargins({ 0, 0 })
local log = hs.logger.new('foo', 5)
-- log.log('logging enabled')
local space=hs.window.filter.new(nil,'space'):setCurrentSpace(true):setDefaultFilter{}

local LEFT = 'Left'
local RIGHT = 'Right'
local UP = 'Up'

function isMaximized(f, max, isPrimary)
  if isPrimary then
    return f.x == max.x - 4 and f.y == max.y and f.w == max.w + 4 and f.h == max.h
  end
  return f.x == max.x and f.y == max.y and f.w == max.w and f.h == max.h
end

function isPushedLeft(f, max, isPrimary)
  if isMaximized(f, max, isPrimary) then return false end
  if f.h ~= max.h then return false end
  return f.x == max.x and f.w == (max.w / 2)
end

function isPushedRight(f, max, isPrimary)
  if isMaximized(f, max, isPrimary) then return false end
  if f.h ~= max.h then return false end
  return (f.x == (max.x + (max.w / 2)) or f.x == (max.x + (max.w/2 - 4))) and (f.w == (max.w / 2) or f.w == (max.w / 2 + 4))
end

function pushLeft()
  local win = hs.window.focusedWindow()
  if not win then return end
  local f = win:frame()
  local screen = win:screen()
  local max = screen:frame()
  local primary = hs.screen.primaryScreen()
  local isPrimary = primary:id() == screen:id()

  if isPushedLeft(f, max, isPrimary) then
    if screen:toWest() == nil then return end
    -- throw left
    win:moveOneScreenWest()
    local f = win:frame()
    local screen = win:screen()
    local max = screen:frame()
    local primary = hs.screen.primaryScreen()
    local isPrimary = primary:id() == screen:id()
    f = splitRight(f, max, isPrimary)
    return win:setFrame(f)
  end

  f = splitLeft(f, max, isPrimary)
  win:setFrame(f)

end

function pushRight()
  local win = hs.window.focusedWindow()
  if not win then return end
  local f = win:frame()
  local screen = win:screen()
  local max = screen:frame()
  local primary = hs.screen.primaryScreen()
  local isPrimary = primary:id() == screen:id()

  if isPushedRight(f, max, isPrimary) then
    if screen:toEast() == nil then return end
    -- throw right
    win:moveOneScreenEast()
    local f = win:frame()
    local screen = win:screen()
    local max = screen:frame()
    local primary = hs.screen.primaryScreen()
    local isPrimary = primary:id() == screen:id()
    f = splitLeft(f, max, isPrimary)
    return win:setFrame(f)
  end

  f = splitRight(f, max, isPrimary)
  win:setFrame(f)
end

function splitLeft(f, max, isPrimary)
  if isPrimary then
    f.x = max.x - 4
    f.w = max.w / 2 + 4
  else
    f.x = max.x
    f.w = max.w / 2
  end

  f.y = max.y
  f.h = max.h
  return f
end

function splitRight(f, max, isPrimary)
  if isPrimary and #hs.screen.allScreens() > 1 then
    f.x = max.x + max.w / 2 - 4
    f.w = max.w / 2 + 4
  else
    f.x = max.x + max.w / 2
    f.w = max.w / 2
  end

  f.y = max.y
  f.h = max.h
  return f
end

function focusLeft()
  space:focusWindowWest(nil, true)
end

function focusRight()
  space:focusWindowEast(nil, true)
end

function maximize()
  local win = hs.window.focusedWindow()
  local f = win:frame()
  local screen = win:screen()
  local max = screen:frame()
  local primary = hs.screen.primaryScreen()
  local isPrimary = primary:id() == screen:id()

  if isPrimary then
    f.x = max.x - 4
    f.y = max.y
    f.w = max.w + 4
    f.h = max.h
    return win:setFrame(f)
  end

  f.x = max.x
  f.y = max.y
  f.w = max.w
  f.h = max.h
  return win:setFrame(f)
end

hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'k', maximize)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'h', pushLeft)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'l', pushRight)
hs.hotkey.bind({"ctrl"}, 'h', focusLeft)
hs.hotkey.bind({"ctrl"}, 'l', focusRight)
