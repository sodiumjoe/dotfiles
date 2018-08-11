-- https://github.com/asmagill/hs._asm.undocumented.spaces
local spaces = require("hs._asm.undocumented.spaces")
hs.window.animationDuration = 0.01
hs.grid.setMargins({ 0, 0 })
-- local log = hs.logger.new('foo', 5)
-- log.log('logging enabled')
local space=hs.window.filter.new(nil,'space'):setCurrentSpace(true):setDefaultFilter{}

local gap = 22

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
  return false
  -- if isSingleScreen() then return false end
  -- local primary = hs.screen.primaryScreen()
  -- return primary:id() ~= screen:id()
end

function isSingleScreen()
  if #hs.screen.allScreens() == 1 then return true end
  return false
end

function isMaximized(f, max, hasSidebar)
  if hasSidebar then
    return f.x == max.x - 4 and f.y == max.y and f.w == max.w + 4 and f.h == max.h
  end
  return f.x == max.x and f.y == max.y and f.w == max.w and f.h == max.h
end

function getLeftGap(max, hasSidebar)
  if hasSidebar then
    return max.x + gap - 4
  end
  return max.x + gap
end

function getSplitWidth(max)
  return max.w / 2 - gap * 1.5
end

function getSplitHeight(max)
  return max.h - gap * 2
end

function getBottomGap(max)
  return max.y + gap
end

function isPushedLeft(f, max, hasSidebar)
  if isMaximized(f, max, hasSidebar) then return false end
  if f.h ~= getSplitHeight(max) then return false end
  return f.x == getLeftGap(max, hasSidebar)
end

function isPushedRight(f, max, hasSidebar)
  if isMaximized(f, max, hasSidebar) then return false end
  if f.h ~= getSplitHeight(max) then return false end
  return f.x == getLeftGap(max, false) + getSplitWidth(max) + gap
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
  f.x = getLeftGap(max, hasSidebar)
  f.w = getSplitWidth(max)
  f.y = getBottomGap(max)
  f.h = getSplitHeight(max)
  return f
end

function splitRight(f, max)
  f.x = getLeftGap(max, hasSidebar) + getSplitWidth(max) + gap
  f.w = getSplitWidth(max)
  f.y = getBottomGap(max)
  f.h = getSplitHeight(max)
  return f
end

function focusLeft()
  space:focusWindowWest(nil, true)
end

function focusRight()
  space:focusWindowEast(nil, true)
end

function maximize(win)
  local win = win or hs.window.focusedWindow()
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

function isLeftSpaceWindow(win)
  return win:application():name() == 'Slack'
end

function isLeftWindow(win)
  local name = win:application():name()
  local title = win:title()
  return name == 'Google Chrome' and not string.match(title, 'Hangouts')
end

function isRightWindow(win)
  local name = win:application():name()
  local title = win:title()
  return string.match(title, 'Hangouts') or name == 'Alacritty'
end

function layout()
  if isSingleScreen() then
    local filter = hs.window.filter.new()
    local windows = filter:getWindows()
    for k, win in pairs(windows) do
      maximize(win)
    end
    return nil
  end

  for k, win in pairs(hs.window.filter.new(isLeftSpaceWindow):getWindows()) do
    if win:isStandard() then
      win:moveOneScreenWest()
      maximize(win)
    end
  end

  for k, win in pairs(hs.window.filter.new(isLeftWindow):getWindows()) do
    if win:isStandard() then
      win:moveOneScreenEast()
      local f = win:frame()
      local screen = win:screen()
      local hasSidebar = getHasSidebar(screen)
      local max = screen:frame()
      f = splitLeft(f, max)
      win:setFrame(f)
    end
  end

  for k, win in pairs(hs.window.filter.new(isRightWindow):getWindows()) do
    win:moveOneScreenEast()
    if win:isStandard() then
      local f = win:frame()
      local screen = win:screen()
      local max = screen:frame()
      f = splitRight(f, max)
      win:setFrame(f)
    end
  end
end

hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'k', maximize)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'h', pushLeft)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'l', pushRight)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'j', layout)
hs.hotkey.bind({"ctrl"}, 'h', focusLeft)
hs.hotkey.bind({"ctrl"}, 'l', focusRight)

-- > hs.window.filter.new():setCurrentSpace(true):getWindows()
-- table: 0x600002870880

-- > hs.window.filter.new():setCurrentSpace(true):getWindows()[4]
-- hs.window: Google Hangouts - joebadmo@gmail.com (0x600000a53a38)

-- > hs.window.filter.new():setCurrentSpace(true):getWindows()[4]:title()
-- Google Hangouts - joebadmo@gmail.com

-- > hs.window.filter.new():setCurrentSpace(true):getWindows()[4]:application()
-- hs.application: Google Chrome (0x600001250ac8)
