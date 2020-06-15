-- https://github.com/asmagill/hs._asm.undocumented.spaces
local spaces = require("hs._asm.undocumented.spaces")
hs.window.animationDuration = 0.01
-- local log = hs.logger.new('foo', 5)
-- log.log('logging enabled')
local space = hs.window.filter.new(nil,'space'):setCurrentSpace(true):setDefaultFilter{}
local chromeFilter = hs.window.filter.new(false):setAppFilter('Google Chrome', {rejectTitles='Hangouts', visible=true})
local hangoutsFilter = hs.window.filter.new(false):setAppFilter('Google Chrome', {allowTitles='Hangouts', visible=true})
local alacrittyFilter = hs.window.filter.new(false):setAppFilter('Alacritty')
local zoomFilter = hs.window.filter.new(false):setAppFilter('zoom.us', {visible=true})
local zoomNonMeetingFilter = hs.window.filter.copy(zoomFilter):setOverrideFilter{rejectTitles='Zoom Meeting'}
local zoomMeetingFilter = hs.window.filter.copy(zoomFilter):setOverrideFilter{allowTitles='Zoom Meeting'}

hs.window.highlight.ui.frameWidth = 10
hs.window.highlight.ui.frameColor = {0,0.6,1,0.5}
hs.window.highlight.start()

local gap = 22

local positions = {
  left  =       {x=0, y=0, w=3, h=6},
  right =       {x=3, y=0, w=3, h=6},
  topLeft  =    {x=0, y=0, w=3, h=3},
  topRight =    {x=3, y=0, w=3, h=3},
  bottomLeft  = {x=0, y=3, w=3, h=3},
  bottomRight = {x=3, y=3, w=3, h=3},
  maximized =   {x=0, y=0, w=6, h=6},
}

hs.grid.setMargins({ gap, gap })
for k, screen in pairs(hs.screen.allScreens()) do
  hs.grid.setGrid('6x6', screen)
end

function indexOf(table, value)
  for k, v in pairs(table) do
    if v == value then return k end
  end
  return nil
end

function focusLeft()
  space:focusWindowWest(nil, true)
end

function focusRight()
  space:focusWindowEast(nil, true)
end

function focusUp()
  space:focusWindowNorth(nil, true)
end

function focusDown()
  space:focusWindowSouth(nil, true)
end

function pushLeft()
  local win = hs.window.focusedWindow()
  local screen = win:screen()
  local screenToWest = screen:toWest()

  if (hs.grid.get(win) ~= positions.left) then
    return hs.grid.set(win, positions.left)
  end

  if (screenToWest) then
    hs.grid.set(win, positions.right, screenToWest)
  end

  local activeSpace = spaces.activeSpace()
  local allSpaces = spaces.layout()[spaces.mainScreenUUID()]
  local activeSpaceIndex = indexOf(allSpaces, activeSpace)
  local spaceToWest = allSpaces[activeSpaceIndex - 1]

  if (spaceToWest) then
    win:spacesMoveTo(spaceToWest)
    local screens = hs.screen.allScreens()
    local lastScreen = screens[#screens]
    hs.grid.set(win, positions.right, lastScreen)
    spaces.changeToSpace(spaceToWest)
  end
end

function pushRight()
  local win = hs.window.focusedWindow()
  local screen = win:screen()

  if (hs.grid.get(win) ~= positions.right) then
    return hs.grid.set(win, positions.right)
  end

  local screenToEast = screen:toEast()

  if (screenToEast) then
    return hs.grid.set(win, positions.left, screenToEast)
  end

  local activeSpace = spaces.activeSpace()
  local allSpaces = spaces.layout()[spaces.mainScreenUUID()]
  local activeSpaceIndex = indexOf(allSpaces, activeSpace)
  local spaceToEast = allSpaces[activeSpaceIndex + 1]

  if (spaceToEast) then
    win:spacesMoveTo(spaceToEast)
    local screens = hs.screen.allScreens()
    local firstScreen = screens[1]
    hs.grid.set(win, positions.left, firstScreen)
    spaces.changeToSpace(spaceToEast)
  end
end

function pushTopLeft()
  local win = hs.window.focusedWindow()
  hs.grid.set(win, positions.topLeft)
end

function pushTopRight()
  local win = hs.window.focusedWindow()
  hs.grid.set(win, positions.topRight)
end

function pushBottomLeft()
  local win = hs.window.focusedWindow()
  hs.grid.set(win, positions.bottomLeft)
end

function pushBottomRight()
  local win = hs.window.focusedWindow()
  hs.grid.set(win, positions.bottomRight)
end

function maximize()
  local win = hs.window.focusedWindow()
  if (hs.screen.mainScreen() == hs.screen.primaryScreen()) then
    win:maximize()
  else
    hs.grid.set(win, positions.maximized)
  end
end

function layoutApp(filter, position, screen, space)
  for k, win in pairs(filter:getWindows()) do
    if space then
      win:spacesMoveTo(space)
    end
    hs.grid.set(win, position, screen)
  end
end

function layout()
  local allSpaces = spaces.layout()[spaces.mainScreenUUID()]
  local screens = hs.screen.allScreens()

  layoutApp(hangoutsFilter, positions.right, screens[2], allSpaces[2])

  if #hs.screen.allScreens() == 1 then
    local filter = hs.window.filter.new()
    local windows = filter:getWindows()
    for k, win in pairs(windows) do
      maximize(win)
    end
    return nil
  end

  layoutApp(chromeFilter, positions.left, screens[2])
  layoutApp(alacrittyFilter, positions.right, screens[2])

  local slack = hs.window.find('Slack')
  if slack then
    slack:moveToScreen(screens[1])
    slack:maximize()
  end

  local zoomMeetings = zoomMeetingFilter:getWindows()
  if zoomMeetings[1] then
    if hs.grid.get(zoomMeetings[1]) == positions.topLeft then
      layoutApp(zoomMeetingFilter, positions.bottomLeft, screens[2])
      layoutApp(zoomNonMeetingFilter, positions.topLeft, screens[2])
    else
      layoutApp(zoomMeetingFilter, positions.topLeft, screens[2])
      layoutApp(zoomNonMeetingFilter, positions.bottomLeft, screens[2])
    end
    for k, win in pairs(zoomFilter:getWindows()) do
      win:focus()
    end
  end
end

hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'k', maximize)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'h', pushLeft)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'l', pushRight)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'u', pushTopLeft)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'o', pushTopRight)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'm', pushBottomLeft)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, '.', pushBottomRight)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'j', layout)
hs.hotkey.bind({"ctrl"}, 'h', focusLeft)
hs.hotkey.bind({"ctrl"}, 'l', focusRight)
