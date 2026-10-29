from contextlib import ExitStack
import ctypes
import fcntl
import hashlib
import json
import locale
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import termios
import tty
import unicodedata

sys.dont_write_bytecode = True

from vendor.easy_motion import TerminalCodes, group_indices


KEYS = 'asdghklqwertyuiopzxcvbnmfj'
DIM = TerminalCodes.Style.parse_style('fg=#899BA6')
DIRECT = TerminalCodes.Style.parse_style('fg=#D18EC2,bold')
FIRST = TerminalCodes.Style.parse_style('fg=#7FC1CA,bold')
SECOND = TerminalCodes.Style.parse_style('fg=#83AFE5')
RESET = TerminalCodes.Style.RESET
locale.setlocale(locale.LC_CTYPE, '')
_wcwidth = ctypes.CDLL(None).wcwidth
_wcwidth.argtypes = [ctypes.c_wchar]
_wcwidth.restype = ctypes.c_int


def cells(line):
    result = []
    col = 0
    for char in line:
        width = _wcwidth(char)
        if width == 0 and result:
            start, text, previous_width = result[-1]
            result[-1] = (start, text + char, previous_width)
        else:
            width = max(width, 1)
            if unicodedata.category(char).startswith('C'):
                char = ' '
            result.append((col, char, width))
            col += width
    return result


def targets(lines, mode, pattern, cursor):
    regex = re.compile(pattern, re.IGNORECASE) if mode == 'pattern' and pattern else None
    found = []
    for row, line in enumerate(lines):
        positions = {}
        offset = 0
        for col, text, width in cells(line):
            for i in range(len(text)):
                positions[offset + i] = col
            offset += len(text)
        if mode == 'words':
            starts = []
            in_word = False
            for i, char in enumerate(line):
                word = char.isalnum() or char == '_'
                if word and not in_word:
                    starts.append(i)
                if not unicodedata.category(char).startswith('M'):
                    in_word = word
        else:
            starts = [m.start() for m in regex.finditer(line) if m.end() > m.start()] if regex else []
        found.extend((row, positions[i]) for i in starts if i in positions)
    return sorted(set(found) - {tuple(cursor)},
                  key=lambda p: (abs(p[0] - cursor[0]) * 10 + abs(p[1] - cursor[1]), p))


def labels_for(points):
    if not points:
        return {}
    result = {}

    def visit(node, prefix):
        if isinstance(node, int):
            result[prefix] = points[node]
        else:
            for key, child in zip(KEYS, node):
                visit(child, prefix + key)

    visit(group_indices(range(len(points)), len(KEYS)), '')
    return result


def render(lines, labels, width, height):
    output = ['\x1b[?25l\x1b[?7l', TerminalCodes.CLEAR_SCREEN]
    for row, line in enumerate(lines[:height]):
        text = ''.join(text for col, text, size in cells(line) if col + size <= width)
        output.extend([TerminalCodes.POSITION_CURSOR.format(row + 1, 1), DIM, text, RESET])
    occupied = set(labels.values())
    for label, (row, col) in labels.items():
        if not label or row >= height or col >= width:
            continue
        output.extend([TerminalCodes.POSITION_CURSOR.format(row + 1, col + 1),
                       DIRECT if len(label) == 1 else FIRST, label[0], RESET])
        for i, char in enumerate(label[1:], 1):
            if col + i >= width or (row, col + i) in occupied:
                break
            output.extend([TerminalCodes.POSITION_CURSOR.format(row + 1, col + i + 1), SECOND, char, RESET])
    return ''.join(output)


def tmux(*args, check=True):
    return subprocess.run(['tmux', *args], check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.rstrip('\n')


def pane_state(pane, client):
    names = ['pane_mode', 'copy_cursor_y', 'copy_cursor_x', 'pane_width', 'pane_height',
             'pane_left', 'pane_top', 'window_offset_x', 'window_offset_y',
             'client_width', 'client_height', 'window_width', 'window_height', 'window_id',
             'scroll_position', 'copy_position_limit', 'selection_present', 'selection_active',
             'selection_start_x', 'selection_start_y', 'selection_end_x', 'selection_end_y',
             'selection_mode', 'rectangle_toggle']
    values = tmux('display-message', '-p', '-c', client, '-t', pane,
                  '|'.join('#{' + name + '}' for name in names)).split('|')
    state = dict(zip(names, values))
    for name in ('window_offset_x', 'window_offset_y'):
        state[name] = state[name] or '0'
    return state


def geometry(state):
    return tuple(state[name] for name in ['pane_width', 'pane_height', 'pane_left', 'pane_top',
                 'window_offset_x', 'window_offset_y', 'client_width', 'client_height', 'window_id'])


def copy_state(state, *, absolute_cursor=False):
    snapshot = {name: state[name] for name in ['pane_mode', 'copy_cursor_y', 'copy_cursor_x',
                 'scroll_position', 'copy_position_limit', 'selection_present', 'selection_active',
                 'selection_start_x', 'selection_start_y', 'selection_end_x', 'selection_end_y',
                 'selection_mode', 'rectangle_toggle']}
    if absolute_cursor:
        snapshot['copy_cursor_y'] = str(int(snapshot['copy_cursor_y']) +
                                       int(snapshot.pop('copy_position_limit')) -
                                       int(snapshot.pop('scroll_position')))
    return tuple(snapshot.values())


def restore_cursor(pane, client, original):
    state = pane_state(pane, client)
    if state['pane_mode'] != 'copy-mode':
        return
    row, col = int(original['copy_cursor_y']), int(original['copy_cursor_x'])
    current_row = int(state['copy_cursor_y'])
    if row != current_row:
        tmux('send-keys', '-t', pane, '-X', '-N', str(abs(row - current_row)),
             'cursor-down' if row > current_row else 'cursor-up')
    tmux('send-keys', '-t', pane, '-X', 'start-of-line')
    current_col = 0
    while current_col < col:
        tmux('send-keys', '-t', pane, '-X', 'cursor-right')
        next_col = int(pane_state(pane, client)['copy_cursor_x'])
        if next_col <= current_col:
            raise ValueError('Cannot restore the original copy cursor')
        current_col = next_col
    if copy_state(pane_state(pane, client)) != copy_state(original):
        raise ValueError('Cannot restore the original copy state')


def move_cursor(pane, client, point, lines):
    state = pane_state(pane, client)
    try:
        row, col = point
        old_row, old_col = int(state['copy_cursor_y']), int(state['copy_cursor_x'])
        if row != old_row:
            tmux('send-keys', '-t', pane, '-X', '-N', str(abs(row - old_row)),
                 'cursor-down' if row > old_row else 'cursor-up')
        old_col = int(pane_state(pane, client)['copy_cursor_x'])
        low, high = sorted((col, old_col))
        steps = sum(low <= x < high for x, text, width in cells(lines[row].ljust(int(state['pane_width']))))
        if steps:
            tmux('send-keys', '-t', pane, '-X', '-N', str(steps),
                 'cursor-right' if col > old_col else 'cursor-left')
        actual = pane_state(pane, client)
        if (int(actual['copy_cursor_y']), int(actual['copy_cursor_x'])) != (row, col):
            raise ValueError('Terminal character widths differ from tmux; jump cancelled')
    except (ValueError, OSError, subprocess.CalledProcessError):
        restore_cursor(pane, client, state)
        raise


def start(pane, client, mode):
    server = os.environ.get('TMUX', '').rsplit(',', 2)[0]
    with ExitStack() as locks:
        for scope in ('client:' + client, 'pane:' + pane):
            identity = server + scope
            name = '.tmux-hop-' + str(os.getuid()) + '-' + hashlib.sha256(identity.encode()).hexdigest()[:20]
            fd = os.open(Path(tempfile.gettempdir()) / name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            lock = locks.enter_context(os.fdopen(fd, 'w'))
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
        before = pane_state(pane, client)
        if before['pane_mode'] not in ('', 'copy-mode'):
            raise ValueError('Hop requires the normal pane or copy mode')
        if not re.search(r'^capture-pane .*\[[^]]*M', tmux('list-commands'), re.MULTILINE):
            raise ValueError('Hop requires tmux 3.7 or newer (capture-pane -M)')
        selected = False
        state = None
        if not before['pane_mode']:
            tmux('copy-mode', '-t', pane)
        try:
            state = pane_state(pane, client)
            if (int(state['window_width']) > int(state['client_width']) or
                    int(state['window_height']) > int(state['client_height']) or
                    int(state['window_offset_x']) or int(state['window_offset_y'])):
                raise ValueError('Hop requires the full pane to fit in this client')
            width, height = int(state['pane_width']), int(state['pane_height'])
            lines = tmux('capture-pane', '-p', '-M', '-N', '-t', pane).split('\n')
            cursor = (int(state['copy_cursor_y']), int(state['copy_cursor_x']))
            with tempfile.TemporaryDirectory(prefix='tmux-hop-') as directory:
                request = Path(directory) / 'request.json'
                result = Path(directory) / 'result.json'
                request.write_text(json.dumps(dict(lines=lines, cursor=cursor, width=width, height=height,
                                                   mode=mode, result=str(result))))
                tmux('display-popup', '-B', '-E', '-c', client, '-t', pane,
                     '-x', '#{popup_pane_left}', '-y', '#{popup_pane_top}',
                     '-w', str(width), '-h', str(height),
                     sys.executable, str(Path(__file__).resolve()), 'overlay', str(request), check=False)
                after = pane_state(pane, client)
                if geometry(after) != geometry(state) or copy_state(after) != copy_state(state):
                    return
                if result.exists():
                    point = json.loads(result.read_text())
                    move_cursor(pane, client, point, lines)
                    selected = True
        finally:
            if not selected and not before['pane_mode'] and state is not None:
                try:
                    current = pane_state(pane, client)
                    unchanged = copy_state(current) == copy_state(state)
                    resized = geometry(current) != geometry(state)
                    if unchanged or (resized and current['pane_mode'] == 'copy-mode' and
                            copy_state(current, absolute_cursor=True) ==
                            copy_state(state, absolute_cursor=True)):
                        tmux('send-keys', '-t', pane, '-X', 'cancel', check=False)
                except (OSError, subprocess.CalledProcessError):
                    pass


def overlay(request_path):
    request = json.loads(Path(request_path).read_text())
    width, height = request['width'], request['height']
    lines, cursor = request['lines'], request['cursor']
    pattern = ''
    reading_pattern = request['mode'] == 'pattern'
    labels = {}
    message = ''
    old_settings = termios.tcgetattr(sys.stdin)

    def resized(signum, frame):
        raise InterruptedError('Popup resized')

    signal.signal(signal.SIGWINCH, resized)
    try:
        tty.setraw(sys.stdin.fileno())
        while True:
            if tuple(os.get_terminal_size()) != (width, height):
                return
            if not reading_pattern:
                if not labels:
                    labels = labels_for(targets(lines, request['mode'], pattern, cursor))
                if not labels:
                    return
                if '' in labels:
                    Path(request['result']).write_text(json.dumps(labels['']))
                    return
            sys.stdout.write(render(lines, labels, width, height))
            if reading_pattern:
                prompt = ('Invalid pattern: ' if message else 'Pattern: ') + pattern
                if message == 'No matches':
                    prompt = 'No matches. Pattern: ' + pattern
                prompt = ''.join(text for col, text, size in cells(prompt) if col + size <= width)
                sys.stdout.write(TerminalCodes.POSITION_CURSOR.format(height, 1) + RESET + '\x1b[2K' + prompt)
            sys.stdout.flush()
            key = sys.stdin.read(1)
            if key in ('', '\x1b', '\x03', '\x04'):
                return
            if reading_pattern:
                if key in ('\r', '\n'):
                    if not pattern:
                        return
                    try:
                        labels = labels_for(targets(lines, 'pattern', pattern, cursor))
                        message = '' if labels else 'No matches'
                        reading_pattern = not bool(labels)
                    except re.error:
                        message = 'Invalid pattern'
                elif key in ('\x7f', '\x08'):
                    pattern = pattern[:-1]
                    message = ''
                elif key == '\x15':
                    pattern = ''
                    message = ''
                elif key.isprintable():
                    pattern += key
                    message = ''
            else:
                matching = {label[1:]: point for label, point in labels.items() if label.startswith(key)}
                if not matching:
                    return
                labels = matching
    except (InterruptedError, OSError):
        return
    finally:
        termios.tcsetattr(sys.stdin, termios.TCSANOW, old_settings)
        sys.stdout.write(RESET + '\x1b[?7h\x1b[?25h')
        sys.stdout.flush()


def main():
    try:
        if sys.argv[1] == 'start':
            start(*sys.argv[2:])
        elif sys.argv[1] == 'overlay':
            overlay(sys.argv[2])
    except (subprocess.CalledProcessError, ValueError, OSError) as error:
        if sys.argv[1] == 'start':
            tmux('display-message', 'Hop: ' + str(error), check=False)
        else:
            raise


if __name__ == '__main__':
    main()