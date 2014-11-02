// Push Bindings

var throwNextLeft = slate.operation('throw', {
  'screen': 'left'
});

var throwNextRight = slate.operation('throw', {
  'screen': 'right'
});

var pushLeft = slate.operation('push', {
  'direction': 'left',
  'style': 'bar-resize:screenSizeX/2'
});

var pushRight = slate.operation('push', {
  'direction': 'right',
  'style': 'bar-resize:screenSizeX/2'
});

var pushedLeft = function(win) {
  if (!win) { return false; }
  var winRect = win.rect(),
      screen = win.screen().visibleRect();

  if ( winRect.x === screen.x
    && winRect.y === screen.y
    && winRect.width === screen.width / 2
    && winRect.height === screen.height
    ) {
    return true;
  }

  return false;
};

var pushedRight = function(win) {
  if (!win) { return false; }
  var winRect = win.rect(),
      screen = win.screen().visibleRect();

  if ( winRect.x === screen.x + screen.width / 2
    && winRect.y === screen.y
    && winRect.width === screen.width / 2
    && winRect.height === screen.height
    ) {
    return true;
  }

  return false;
};

slate.bind('left:ctrl,cmd', function(win) {
  if (!win) { return; }
  win.doOperation( pushedLeft(win) ? throwNextLeft : pushLeft );
});

slate.bind('right:ctrl,cmd', function(win) {
  if (!win) { return; }
  win.doOperation( pushedRight(win) ? throwNextRight : pushRight );
});
