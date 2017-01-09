hs.window.animationDuration = 0.01
hs.grid.setMargins({ 0, 0 })
-- local log = hs.logger.new('foo', 5)
local space=hs.window.filter.new(nil,'space'):setCurrentSpace(true):setDefaultFilter{}

local LEFT = 'Left'
local RIGHT = 'Right'
local UP = 'Up'

function isMaximized(f, screen, max)
  local primary = hs.screen.primaryScreen()
  local isPrimary = primary:id() == screen:id()
  if isPrimary then
    return (f.x == max.x - 4) and f.y == max.y and f.w == max.w + 4 and f.h == max.h
  else
    return f.x == max.x and f.y == max.y and f.w == max.w and f.h == max.h
  end
end

function isPushed(dir, f, max)
  if not f.h == max.h then return false end
  if dir == LEFT then return f.x == max.x and f.w == (max.w / 2) end
  if dir == RIGHT then return (f.x == (max.x + (max.w / 2)) or f.x == (max.x + (max.w/2 - 4))) and (f.w == (max.w / 2) or f.w == (max.w / 2 + 4)) end
end

function throw(dir, win)

  if (dir == LEFT and screen:toEast() == nil) or
    (dir == RIGHT and screen:toWest() == nil) then
    return
  end

  if dir == LEFT then
    win:moveOneScreenWest()
    split(RIGHT)
  else
    win:moveOneScreenEast()
    split(LEFT)
  end
end

function push(dir)
  local win = hs.window.focusedWindow()
  if not win then return end
  local f = win:frame()
  local screen = win:screen()
  local max = screen:frame()

  if isPushed(dir, f, max) and not isMaximized(f, screen, max) then
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
  local primary = hs.screen.primaryScreen()
  local isMultipleScreens = #hs.screen.allScreens() > 1
  local isPrimary = primary:id() == screen:id()

  if dir == LEFT then
    if isPrimary then
      f.x = max.x - 4
      f.w = max.w / 2 + 4
    else
      f.x = max.x
      f.w = max.w / 2
    end
  else
    if isPrimary and isMultipleScreens then
      f.x = max.x + max.w / 2 - 4
      f.w = max.w / 2 + 4
    else
      f.x = max.x + max.w / 2
      f.w = max.w / 2
    end
  end

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
  else
    f.x = max.x
    f.y = max.y
    f.w = max.w
    f.h = max.h
  end
  win:setFrame(f)
end

hs.hotkey.bind({"alt", "ctrl"}, UP, maximize)
hs.hotkey.bind({"cmd", "ctrl"}, LEFT, pushLeft)
hs.hotkey.bind({"cmd", "ctrl"}, RIGHT, pushRight)
hs.hotkey.bind({"ctrl"}, 'h', focusLeft)
hs.hotkey.bind({"ctrl"}, 'l', focusRight)
