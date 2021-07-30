local padding = ' '
local highlightReset = '%*'
local separator='%#StatusLineSeparator#│'..highlightReset
local activeHighlight = '%#StatusLineActiveItem#'
local errorHighlight = '%#StatusLineError#'
local warningHighlight = '%#StatusLineWarning#'
local alignmentGroup = '%='

local filename = '%<%{expand("%:~:.")}'
local helpModifiedReadOnly = '%(%h%m%r%)'
local lines = 'L%l/%L'
local virtualColumn = 'C%02v'

function highlightItem(item, h)
  return h..item..highlightReset
end

function padItem(item)
  return padding..item..padding
end

function getLines()
  -- pad current line number to number of digits in total lines to keep length
  -- of segment consistent
  local numLines = vim.fn.line('$')
  local numDigits = string.len(numLines)
  return 'L%0'..numDigits..'l/%L'
end

function lspStatus()
  local client_names = {}
  local clients = vim.lsp.buf_get_clients()
  if #clients == 0 then return nil end
  for _, client in ipairs(clients) do
    table.insert(client_names, client.name)
  end
  return table.concat(client_names, separator)
end

function insertItem(t, value)
  if value then table.insert(t, padItem(value)) end
end

function _G.activeLine()
  local leftSegment = table.concat({
    highlightItem(padItem(filename), activeHighlight),
    helpModifiedReadOnly,
  }, padding)

  local rightSegmentItems = {}
  insertItem(rightSegmentItems, lspStatus())
  insertItem(rightSegmentItems, getLines())
  insertItem(rightSegmentItems, virtualColumn)

  local rightSegment = separator..table.concat(rightSegmentItems, separator)

  return table.concat({leftSegment, rightSegment}, alignmentGroup)
end

function _G.inactiveLine()
  local leftSegment = table.concat({
    padItem(filename),
    padItem(helpModifiedReadOnly),
  }, separator)

  local rightSegmentItems = {}
  insertItem(rightSegmentItems, lspStatus())
  insertItem(rightSegmentItems, getLines())
  insertItem(rightSegmentItems, virtualColumn)

  local rightSegment = separator..table.concat(rightSegmentItems, separator)

  return table.concat({leftSegment, rightSegment}, alignmentGroup)
end
