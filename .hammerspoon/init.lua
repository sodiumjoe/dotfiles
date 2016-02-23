hs.window.animationDuration = 0
hs.grid.setMargins({ 0, 0 })
local log = hs.logger.new('foo', 5)
local space=hs.window.filter.new(nil,'space'):setCurrentSpace(true):setDefaultFilter{}

local LEFT = 'Left'
local RIGHT = 'Right'
local UP = 'Up'

function isPushed(dir, f, max)
  if not f.h == max.h then return false end
  if dir == LEFT then return f.x == max.x and f.w == (max.w / 2) end
  if dir == RIGHT then return f.x == (max.x + (max.w / 2)) and f.w == (max.w / 2) end
end

function throw(dir, win)
  if dir == LEFT then
    win:moveOneScreenWest(100)
    split(RIGHT)
  else
    win:moveOneScreenEast(100)
    split(LEFT)
  end
end

function push(dir)
  local win = hs.window.focusedWindow()
  if not win then return end
  local f = win:frame()
  local screen = win:screen()
  local max = screen:frame()

  if isPushed(dir, f, max) then
    throw(dir, win)
  else
    split(dir)
  end
end

function split(dir)
  local win = hs.window.focusedWindow()
  local f = win:frame()
  local screen = win:screen()
  local max = screen:frame()

  if dir == LEFT then
    f.x = max.x
  else
    f.x = max.x + max.w / 2
  end

  f.w = max.w / 2
  f.y = max.y
  f.h = max.h
  win:setFrame(f)
end

function pushLeft() push(LEFT) end
function pushRight() push(RIGHT) end

function focusLeft()
  space:focusWindowWest(nil, true)
end

function focusRight()
  space:focusWindowEast(nil, true)
end

hs.hotkey.bind({"alt", "ctrl"}, UP, hs.grid.maximizeWindow)
hs.hotkey.bind({"cmd", "ctrl"}, LEFT, pushLeft)
hs.hotkey.bind({"cmd", "ctrl"}, RIGHT, pushRight)
hs.hotkey.bind({"ctrl"}, 'h', focusLeft)
hs.hotkey.bind({"ctrl"}, 'l', focusRight)
