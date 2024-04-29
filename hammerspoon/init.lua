hs.window.animationDuration = 0.01
-- local log = hs.logger.new("foo", 5)
-- log.log("logging enabled")
local chromeFilter = hs.window.filter.new(false):setAppFilter("Google Chrome", { visible = true })
local calendarFilter = hs.window.filter.new(false):setAppFilter("Google Calendar", { visible = true })
local chatFilter = hs.window.filter.new(false):setAppFilter("Google Chat", { visible = true })
local alacrittyFilter = hs.window.filter.new(false):setAppFilter("Alacritty")
local zoomFilter = hs.window.filter.new(false):setAppFilter("zoom.us", { visible = true })
local zoomNonMeetingFilter = hs.window.filter.copy(zoomFilter):setOverrideFilter({ rejectTitles = "Zoom Meeting" })
local zoomMeetingFilter = hs.window.filter.copy(zoomFilter):setOverrideFilter({ allowTitles = "Zoom Meeting" })
local slackFilter = hs.window.filter.new(false):setAppFilter("Slack", { visible = true })

-- hs.window.highlight.ui.overlay=true
hs.window.highlight.ui.overlayColor = { 0, 0, 0, 0.001 }
hs.window.highlight.ui.frameWidth = 10
hs.window.highlight.ui.frameColor = { 0, 0, 0, 0.25 }
hs.window.highlight.start()

local gap = 22

local function resetScreenRotations()
	local middle = hs.screen.find("81044D97-F0BF-4515-AE1C-ACE958274C97")
	local rotated = false
	if middle:rotate() ~= 90 then
		middle:rotate(90)
		rotated = true
	end
	local right = hs.screen.find("D2ADD566-96EC-4E80-BAEF-5BA40FD6E2FC")
	if right:rotate() ~= 270 then
		right:rotate(270)
		rotated = true
	end
	if rotated then
		hs.timer.usleep(100)
	end
end

local positions = {
	left = { x = 0, y = 0, w = 12, h = 24 },
	right = { x = 12, y = 0, w = 12, h = 24 },
	top = { x = 0, y = 0, w = 24, h = 8 },
	topLeft = { x = 0, y = 0, w = 12, h = 8 },
	topRight = { x = 12, y = 0, w = 12, h = 8 },
	bottom = { x = 0, y = 8, w = 24, h = 16 },
	bottomLeft = { x = 0, y = 12, w = 12, h = 12 },
	bottomRight = { x = 12, y = 12, w = 12, h = 12 },
	maximized = { x = 0, y = 0, w = 24, h = 24 },
	topZoom = { x = 1, y = 8, w = 22, h = 8 },
	bottomZoom = { x = 1, y = 16, w = 22, h = 8 },
}

local function resetGrid()
	hs.grid.setMargins({ gap, gap })
	for _, screen in pairs(hs.screen.allScreens()) do
		hs.grid.setGrid("24x24", screen)
	end
end

resetGrid()

local function isLaptopScreen(win)
	return win:screen() == hs.screen.primaryScreen()
end

local function isWorkstation()
	return #hs.screen.allScreens() > 1
end

local function moveToSlot(slot, win)
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

local function focusLeft()
	hs.window.frontmostWindow():focusWindowWest(hs.window.filter.defaultCurrentSpace:getWindows(), true)
end

local function focusRight()
	hs.window.frontmostWindow():focusWindowEast(hs.window.filter.defaultCurrentSpace:getWindows(), true)
end

-- local function focusUp()
-- 	hs.window.frontmostWindow():focusWindowNorth(nil, true)
-- end

-- local function focusDown()
-- 	hs.window.frontmostWindow():focusWindowSouth(nil, true)
-- end

local function pushLeft()
	local win = hs.window.frontmostWindow()
	local screen = win:screen()

	if hs.grid.get(win) ~= positions.left and not isWorkstation() then
		return hs.grid.set(win, positions.left)
	end

	local screenToWest = screen:toWest()

	local position = (isWorkstation() and positions.bottom) or positions.right
	if screenToWest then
		hs.grid.set(win, position, screenToWest)
		if isWorkstation() and isLaptopScreen(win) then
			win:maximize()
		end
		return
	end
end

local function pushRight()
	local win = hs.window.frontmostWindow()
	local screen = win:screen()

	if hs.grid.get(win) ~= positions.right and not isWorkstation() then
		return hs.grid.set(win, positions.right)
	end

	local screenToEast = screen:toEast()

	local position = isWorkstation() and positions.bottom or positions.left

	if screenToEast then
		return hs.grid.set(win, position, screenToEast)
	end
end

local function pushTop()
	local win = hs.window.frontmostWindow()
	hs.grid.set(win, positions.top)
end

local function pushBottom()
	local win = hs.window.frontmostWindow()
	hs.grid.set(win, positions.bottom)
end

local function pushTopLeft()
	local win = hs.window.frontmostWindow()
	hs.grid.set(win, positions.topLeft)
end

-- local function pushTopRight()
-- 	local win = hs.window.frontmostWindow()
-- 	hs.grid.set(win, positions.topRight)
-- end

local function pushBottomLeft()
	local win = hs.window.frontmostWindow()
	hs.grid.set(win, positions.bottomLeft)
end

-- local function pushBottomRight()
-- 	local win = hs.window.frontmostWindow()
-- 	hs.grid.set(win, positions.bottomRight)
-- end

local function maximize(win)
	win = win or hs.window.frontmostWindow()
	if isLaptopScreen(win) then
		win:maximize()
	else
		hs.grid.set(win, positions.maximized)
	end
end

local function layoutWin(win, screenIndex, position)
	for screen, screenPos in pairs(hs.screen.screenPositions()) do
		if screenPos.x == screenIndex then
			hs.grid.set(win, position, screen)
		end
	end
end

local function layoutApp(filter, screenIndex, position)
	for _, win in pairs(filter:getWindows()) do
		layoutWin(win, screenIndex, position)
	end
end

local function layout()
	local screens = hs.screen.allScreens()

	local speakers = hs.audiodevice.findOutputByName("CalDigit Thunderbolt 3 Audio")
		or hs.audiodevice.findOutputByName("MacBook Pro Speakers")
	if speakers then
		speakers:setDefaultOutputDevice()
	end

	local mic = hs.audiodevice.findInputByName("Yeti Nano") or hs.audiodevice.findInputByName("MacBook Pro Microphone")
	if mic then
		mic:setDefaultInputDevice()
	end

	if #screens == 1 then
		for _, win in pairs(chatFilter:getWindows()) do
			win:maximize()
		end

		local filter = hs.window.filter.new()
		local windows = filter:getWindows()
		for _, win in pairs(windows) do
			maximize(win)
		end
		return nil
	end

	resetScreenRotations()
	resetGrid()

	layoutApp(chatFilter, 2, positions.bottom)
	layoutApp(alacrittyFilter, 2, positions.bottom)
	layoutApp(calendarFilter, 2, positions.top)

	local slack = slackFilter:getWindows()[1]
	if slack then
		layoutWin(slack, 0, positions.maximized)
		slack:maximize()
	end

	local zoomMeetings = zoomMeetingFilter:getWindows()
	local zoomNonMeetingWindows = zoomNonMeetingFilter:getWindows()
	local mainZoomWindow = zoomNonMeetingWindows[1]
	local zoom = zoomMeetings[2]
	local zoomMeeting = zoomMeetings[1]

	if mainZoomWindow then
		hs.grid.set(mainZoomWindow, positions.maximized, hs.screen.primaryScreen())
		mainZoomWindow:maximize()
		mainZoomWindow:sendToBack()
	end

	-- active zoom meeting
	if zoomMeeting then
		-- move chrome windows to the right
		layoutApp(chromeFilter, 2, positions.bottom)
		layoutApp(alacrittyFilter, 2, positions.bottom)

		if hs.grid.get(zoomMeeting) == positions.topZoom then
			layoutWin(zoomMeeting, 1, positions.bottomZoom)
			layoutWin(zoom, 1, positions.topZoom)
		else
			layoutWin(zoomMeeting, 1, positions.topZoom)
			layoutWin(zoom, 1, positions.bottomZoom)
		end
		zoom:focus()
		if speakers then
			speakers:setInputVolume(90)
		end
	else
		layoutApp(chromeFilter, 1, positions.bottom)
		if speakers then
			speakers:setInputVolume(25)
		end
	end
end

local function mute_zoom_or_global()
	if #zoomFilter:getWindows() > 1 then
		hs.eventtap.keyStroke({ "cmd", "shift" }, "a", nil, hs.application.find("zoom"))
	else
		hs.eventtap.event.newSystemKeyEvent("PLAY", true):post()
	end
end

local function reload()
	hs.reload()
end

hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "k", maximize)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "h", pushLeft)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "l", pushRight)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "u", pushTopLeft)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "o", pushTop)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "m", pushBottomLeft)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, ".", pushBottom)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "j", layout)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "1", function()
	moveToSlot(1)
end)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "2", function()
	moveToSlot(2)
end)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "3", function()
	moveToSlot(3)
end)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "4", function()
	moveToSlot(4)
end)
hs.hotkey.bind({ "cmd", "ctrl", "shift" }, "r", reload)
hs.hotkey.bind({ "ctrl" }, "h", focusLeft)
hs.hotkey.bind({ "ctrl" }, "l", focusRight)
hs.hotkey.bind({}, "f20", mute_zoom_or_global)
-- hs.hotkey.bind({"ctrl"}, 'o', focusUp)
-- hs.hotkey.bind({"ctrl"}, '.', focusDown)
