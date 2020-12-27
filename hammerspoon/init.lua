-- https://github.com/asmagill/hs._asm.undocumented.spaces
local hsSpaces = require("hs._asm.undocumented.spaces")
hs.window.animationDuration = 0.01
-- local log = hs.logger.new('foo', 5)
-- log.log('logging enabled')
local space = hs.window.filter.new(nil,'space'):setCurrentSpace(true):setDefaultFilter{}
local chromeFilter = hs.window.filter.new(false):setAppFilter('Google Chrome', {visible=true})
local mainChromeWindowTitle = "Stripe %- Calendar.*"
local mainChromeFilter = hs.window.filter.copy(chromeFilter):setOverrideFilter{allowTitles=mainChromeWindowTitle}
local projectChromeFilter = hs.window.filter.copy(chromeFilter):setOverrideFilter{rejectTitles=mainChromeWindowTitle}
local chatFilter = hs.window.filter.new(false):setAppFilter('Google Chat', {visible=true})
local alacrittyFilter = hs.window.filter.new(false):setAppFilter('Alacritty')
local zoomFilter = hs.window.filter.new(false):setAppFilter('zoom.us', {visible=true}):setSortOrder(hs.window.filter.sortByCreated)
local zoomNonMeetingFilter = hs.window.filter.copy(zoomFilter):setOverrideFilter{rejectTitles='Zoom Meeting'}:setSortOrder(hs.window.filter.sortByCreated)
local zoomMeetingFilter = hs.window.filter.copy(zoomFilter):setOverrideFilter{allowTitles='Zoom Meeting'}
local slackFilter = hs.window.filter.new(false):setAppFilter('Slack', {visible=true})

-- hs.window.highlight.ui.overlay=true
hs.window.highlight.ui.overlayColor = {0,0,0,0.001}
hs.window.highlight.ui.frameWidth = 10
hs.window.highlight.ui.frameColor = {0,0,0,0.25}
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

function getSpaces()
  return hsSpaces.layout()[hsSpaces.mainScreenUUID()]
end

function isLaptopScreen()
  return hs.screen.mainScreen():frame().w == 1792
end

function moveToSlot(slot, win)
  win = win or hs.window.frontmostWindow()
  local screens = hs.screen.allScreens()
  if slot == 1 then
    local screen = screens[1]
    return hs.grid.set(win, positions.left, screen)
  elseif slot == 2 then
    local screen = screens[1]
    return hs.grid.set(win, positions.right, screen)
  elseif #screens < 2 then
      return
  elseif slot == 3 then
    local screen = screens[2]
    return hs.grid.set(win, positions.left, screen)
  elseif slot == 4 then
    local screen = screens[2]
    return hs.grid.set(win, positions.right, screen)
  end
end

function focusLeft()
  hs.window.frontmostWindow():focusWindowWest(nil, true)
end

function focusRight()
  hs.window.frontmostWindow():focusWindowEast(nil, true)
end

function focusUp()
  hs.window.frontmostWindow():focusWindowNorth(nil, true)
end

function focusDown()
  hs.window.frontmostWindow():focusWindowSouth(nil, true)
end

function pushLeft()
  local win = hs.window.frontmostWindow()
  local screen = win:screen()

  if (hs.grid.get(win) ~= positions.left) then
    return hs.grid.set(win, positions.left)
  end

  local screenToWest = screen:toWest()

  if (screenToWest) then
    return hs.grid.set(win, positions.right, screenToWest)
  end

  local activeSpace = hsSpaces.activeSpace()
  local spaces = getSpaces()
  local activeSpaceIndex = indexOf(spaces, activeSpace)
  local spaceToWest = spaces[activeSpaceIndex - 1]

  if (spaceToWest) then
    win:spacesMoveTo(spaceToWest)
    local screens = hs.screen.allScreens()
    local lastScreen = screens[#screens]
    hs.grid.set(win, positions.right, lastScreen)
    hsSpaces.changeToSpace(spaceToWest)
  end
end

function pushRight()
  local win = hs.window.frontmostWindow()
  local screen = win:screen()

  if (hs.grid.get(win) ~= positions.right) then
    return hs.grid.set(win, positions.right)
  end

  local screenToEast = screen:toEast()

  if (screenToEast) then
    return hs.grid.set(win, positions.left, screenToEast)
  end

  local activeSpace = hsSpaces.activeSpace()
  local spaces = getSpaces()
  local activeSpaceIndex = indexOf(spaces, activeSpace)
  local spaceToEast = spaces[activeSpaceIndex + 1]

  if (spaceToEast) then
    win:spacesMoveTo(spaceToEast)
    local screens = hs.screen.allScreens()
    local firstScreen = screens[1]
    hs.grid.set(win, positions.left, firstScreen)
    hsSpaces.changeToSpace(spaceToEast)
  end
end

function pushTopLeft()
  local win = hs.window.frontmostWindow()
  hs.grid.set(win, positions.topLeft)
end

function pushTopRight()
  local win = hs.window.frontmostWindow()
  hs.grid.set(win, positions.topRight)
end

function pushBottomLeft()
  local win = hs.window.frontmostWindow()
  hs.grid.set(win, positions.bottomLeft)
end

function pushBottomRight()
  local win = hs.window.frontmostWindow()
  hs.grid.set(win, positions.bottomRight)
end

function maximize()
  local win = hs.window.frontmostWindow()
  if (isLaptopScreen()) then
    win:maximize()
  else
    hs.grid.set(win, positions.maximized)
  end
end

function layoutApp(filter, slot, space)
  for k, win in pairs(filter:getWindows()) do
    if space then
      win:spacesMoveTo(space)
    end
    moveToSlot(slot, win)
  end
end

function layout()
  local spaces = getSpaces()
  local screens = hs.screen.allScreens()
  hs.window.find("Chrome"):application():selectMenuItem(mainChromeWindowTitle, true)

  if #screens == 1 then
    for k, win in pairs(chatFilter:getWindows()) do
      win:spacesMoveTo(spaces[2])
      win:maximize()
    end

    local filter = hs.window.filter.new()
    local windows = filter:getWindows()
    for k, win in pairs(windows) do
      maximize(win)
    end
    return nil
  end

  layoutApp(chatFilter, 3, spaces[2])
  layoutApp(alacrittyFilter, 3)
  layoutApp(slackFilter, 1)

  local zoomMeetings = zoomMeetingFilter:getWindows()
  local zoomNonMeetingWindows = zoomNonMeetingFilter:getWindows()
  local mainZoomWindow = zoomNonMeetingWindows[1]
  local zoom = zoomNonMeetingWindows[2]
  local zoomMeeting = zoomMeetings[1]

  if mainZoomWindow then
    moveToSlot(1, mainZoomWindow)
    mainZoomWindow:sendToBack()
  end

  -- active zoom meeting
  if zoomMeeting then
    -- move chrome windows to the right
    layoutApp(projectChromeFilter, 3)
    layoutApp(alacrittyFilter, 4)

    if hs.grid.get(zoomMeeting) == positions.topRight then
      hs.grid.set(zoomMeeting, positions.bottomRight, screens[1])
      hs.grid.set(zoom, positions.topRight, screens[1])
    else
      hs.grid.set(zoomMeeting, positions.topRight, screens[1])
      hs.grid.set(zoom, positions.bottomRight, screens[1])
    end
    zoom:focus()
  else
    layoutApp(projectChromeFilter, 2)
    layoutApp(mainChromeFilter, 4)
    layoutApp(alacrittyFilter, 3)
  end
end

function reload()
  hs.reload()
end

local screenWatcher = hs.screen.watcher.new(reload)

screenWatcher:start()

hs.hotkey.bind({"option", "ctrl", "shift"}, 'k', maximize)
hs.hotkey.bind({"option", "ctrl", "shift"}, 'h', pushLeft)
hs.hotkey.bind({"option", "ctrl", "shift"}, 'l', pushRight)
hs.hotkey.bind({"option", "ctrl", "shift"}, 'u', pushTopLeft)
hs.hotkey.bind({"option", "ctrl", "shift"}, 'o', pushTopRight)
hs.hotkey.bind({"option", "ctrl", "shift"}, 'm', pushBottomLeft)
hs.hotkey.bind({"option", "ctrl", "shift"}, '.', pushBottomRight)
hs.hotkey.bind({"option", "ctrl", "shift"}, 'j', layout)
hs.hotkey.bind({"option", "ctrl", "shift"}, '1', function() moveToSlot(1) end)
hs.hotkey.bind({"option", "ctrl", "shift"}, '2', function() moveToSlot(2) end)
hs.hotkey.bind({"option", "ctrl", "shift"}, '3', function() moveToSlot(3) end)
hs.hotkey.bind({"option", "ctrl", "shift"}, '4', function() moveToSlot(4) end)
hs.hotkey.bind({"cmd", "ctrl", "shift"}, 'r', reload)
hs.hotkey.bind({"ctrl"}, 'h', focusLeft)
hs.hotkey.bind({"ctrl"}, 'l', focusRight)
