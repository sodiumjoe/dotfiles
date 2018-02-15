-- https://github.com/asmagill/hs._asm.undocumented.spaces
local spaces = require("hs._asm.undocumented.spaces")
hs.window.animationDuration = 0.01
hs.grid.setMargins({ 0, 0 })
-- local log = hs.logger.new('foo', 5)
-- log.log('logging enabled')
local space=hs.window.filter.new(nil,'space'):setCurrentSpace(true):setDefaultFilter{}

function indexOf(table, value)
  for k, v in pairs(table) do
    if v == value then return k end
  end
  return nil
end

function pushSpaceLeft(win)
  local currentSpace = spaces.query(spaces.masks.currentSpaces)[1]
  local currentSpaces = spaces.layout()[spaces.mainScreenUUID()]
  local currentSpaceIndex = indexOf(currentSpaces, currentSpace)
  if currentSpaceIndex == nil then return end
  local spaceId = currentSpaces[currentSpaceIndex - 1]
  if spaceId == nil then return end
  spaces.moveWindowToSpace(win:id(), spaceId)
  pushRight(win)
  spaces.changeToSpace(spaceId)
end

function pushSpaceRight(win)
  local currentSpace = spaces.query(spaces.masks.currentSpaces)[1]
  local currentSpaces = spaces.layout()[spaces.mainScreenUUID()]
  local currentSpaceIndex = indexOf(currentSpaces, currentSpace)
  if currentSpaceIndex == nil then return end
  local spaceId = currentSpaces[currentSpaceIndex + 1]
  if spaceId == nil then return end
  spaces.moveWindowToSpace(win:id(), spaceId)
  pushLeft(win)
  spaces.changeToSpace(spaceId)
end

local LEFT = 'Left'
local RIGHT = 'Right'
local UP = 'Up'

function getHasSidebar(screen)
  if #hs.screen.allScreens() == 1 then return true end
  local primary = hs.screen.primaryScreen()
  return primary:id() ~= screen:id()
end

function isMaximized(f, max, hasSidebar)
  if hasSidebar then
    return f.x == max.x - 4 and f.y == max.y and f.w == max.w + 4 and f.h == max.h
  end
  return f.x == max.x and f.y == max.y and f.w == max.w and f.h == max.h
end

function isPushedLeft(f, max, hasSidebar)
  if isMaximized(f, max, hasSidebar) then return false end
  if f.h ~= max.h then return false end
  if hasSidebar then
    return f.x == max.x - 4
  end
  return f.x == max.x
end

function isPushedRight(f, max, hasSidebar)
  if isMaximized(f, max, hasSidebar) then return false end
  if f.h ~= max.h then return false end
  return f.x == (max.x + (max.w / 2)) or f.x == (max.x + (max.w/2 - 4))
end

function pushLeft(win)
  win = win or hs.window.focusedWindow()
  if not win then return end
  local f = win:frame()
  local screen = win:screen()
  local max = screen:frame()
  local hasSidebar = getHasSidebar(screen)

  if isPushedLeft(f, max, hasSidebar) then
    if screen:toWest() == nil then
      return pushSpaceLeft(win)
    end
    -- throw left
    win:moveOneScreenWest()
    local f = win:frame()
    local screen = win:screen()
    local max = screen:frame()
    local hasSidebar = getHasSidebar(screen)
    f = splitRight(f, max)
    return win:setFrame(f)
  end

  f = splitLeft(f, max, hasSidebar)
  win:setFrame(f)
end

function pushRight(win)
  win = win or hs.window.focusedWindow()
  if not win then return end
  local f = win:frame()
  local screen = win:screen()
  local max = screen:frame()
  local hasSidebar = getHasSidebar(screen)

  if isPushedRight(f, max, hasSidebar) then
    if screen:toEast() == nil then
      return pushSpaceRight(win)
    end
    -- throw right
    win:moveOneScreenEast()
    local f = win:frame()
    local screen = win:screen()
    local max = screen:frame()
    local hasSidebar = getHasSidebar(screen)
    f = splitLeft(f, max, hasSidebar)
    return win:setFrame(f)
  end

  f = splitRight(f, max)
  win:setFrame(f)
end

function splitLeft(f, max, hasSidebar)
  if hasSidebar then
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

function splitRight(f, max)
  f.x = max.x + max.w / 2
  f.w = max.w / 2
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
  local hasSidebar = getHasSidebar(screen)

  if hasSidebar then
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
