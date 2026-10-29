import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest

from test_hop import HOP, hop


class TmuxHopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='tmux hop test ')
        self.root = Path(self.tmp.name)
        self.socket = str(self.root / 'server.sock')
        self.env = dict(os.environ, TMUX='', HOME=str(self.root), TMPDIR=str(self.root),
                        TERM='xterm-256color')
        self.env['PATH'] = os.pathsep.join([str(Path(sys.executable).parent),
                                          str(Path(shutil.which('tmux')).parent), '/usr/bin', '/bin'])
        self.client = None
        self.master = None
        self.drivers = []
        self.extra_clients = []
        config = self.root / '.config/tmux/hop'
        config.parent.mkdir(parents=True)
        config.symlink_to(HOP.parent)
        self.fixture = self.root / 'fixture.py'
        self.fixture.write_text("import time\nprint('alpha beta gamma', flush=True)\ntime.sleep(120)")
        self.tmux('new-session', '-d', '-s', 'test', '-x', '70', '-y', '20', '-c', str(self.root),
                  sys.executable, str(self.fixture))
        self.tmux('set', '-g', 'status', 'off')
        self.tmux('set', '-g', 'prefix', 'C-a')
        self.tmux('setw', '-g', 'mode-keys', 'vi')
        self.tmux('set', '-as', 'terminal-features', ',*:RGB')
        self.tmux('bind', 'j', 'select-pane', '-D')
        self.tmux('bind', '-r', 'Space', 'select-pane', '-t:.+')
        self.tmux('bind', '-T', 'copy-mode-vi', 'v', 'send', '-X', 'begin-selection')
        self.tmux('bind', '-T', 'copy-mode-vi', 'y', 'send', '-X', 'copy-selection')
        fragment = HOP.parent / 'hop.conf'
        if fragment.exists():
            self.tmux('source-file', str(fragment))
        self.pane = self.tmux('display', '-p', '#{pane_id}').strip()
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 70, 0, 0))
        self.client = subprocess.Popen(['tmux', '-S', self.socket, 'attach', '-t', 'test'],
                                       stdin=slave, stdout=slave, stderr=slave, env=self.env)
        os.close(slave)
        self.wait_for(lambda: self.tmux('list-clients', '-F', '#{client_name}').strip())
        self.client_name = self.tmux('list-clients', '-F', '#{client_name}').strip()
        self.wait_for(lambda: 'alpha beta gamma' in self.tmux('capturep', '-p', '-t', self.pane))
        self.drain()

    def tearDown(self):
        subprocess.run(['tmux', '-S', self.socket, 'kill-server'], env=self.env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for proc in self.drivers:
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            proc.stdout.close()
        for client, master in self.extra_clients:
            client.wait(timeout=3)
            os.close(master)
        if self.client:
            self.client.wait(timeout=3)
        if self.master is not None:
            os.close(self.master)
        self.tmp.cleanup()

    def tmux(self, *args):
        return subprocess.check_output(['tmux', '-S', self.socket, '-f', '/dev/null', *args],
                                       env=self.env, text=True, stderr=subprocess.DEVNULL)

    def wait_for(self, condition, timeout=4):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            result = condition()
            if result:
                return result
            time.sleep(.02)
        self.fail('Timed out waiting for tmux state')

    def drain(self):
        data = b''
        while select.select([self.master], [], [], .05)[0]:
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                break
            if not chunk:
                break
            data += chunk
        return data

    def wait_screen(self, text):
        screen = bytearray()
        def ready():
            screen.extend(self.drain())
            return text.encode() in screen
        self.wait_for(ready)
        return bytes(screen)

    def state(self):
        values = self.tmux('display', '-p', '-t', self.pane,
                           '#{pane_mode}:#{copy_cursor_y}:#{copy_cursor_x}:#{scroll_position}').strip().split(':')
        return values[0], tuple(int(v or 0) for v in values[1:])

    def attach_second_client(self):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 70, 0, 0))
        client = subprocess.Popen(['tmux', '-S', self.socket, 'attach', '-t', 'test'],
                                  stdin=slave, stdout=slave, stderr=slave, env=self.env)
        os.close(slave)
        self.extra_clients.append((client, master))
        self.wait_for(lambda: len(self.tmux('list-clients', '-F', '#{client_name}').splitlines()) == 2)
        return next(name for name in self.tmux('list-clients', '-F', '#{client_name}').splitlines()
                    if name != self.client_name)

    def start(self, mode='words', client=None):
        proc = subprocess.Popen([sys.executable, str(HOP), 'start', self.pane, client or self.client_name, mode],
                                env=dict(self.env, TMUX=self.socket + ',0,0'),
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.drivers.append(proc)
        return proc

    def finish(self, proc):
        end = time.monotonic() + 4
        while proc.poll() is None and time.monotonic() < end:
            self.drain()
        self.assertIsNotNone(proc.poll(), 'Hop controller did not finish after popup closure')
        output = proc.communicate()[0]
        self.assertEqual(proc.returncode, 0, output)
        self.assertFalse(list(self.root.glob('tmux-hop-*')), 'Temporary capture directory leaked')
        self.assertEqual(self.tmux('list-windows', '-F', '#{window_id}').count('\n'), 1)

    def test_prefix_word_binding_lands_in_copy_mode_and_can_select(self):
        self.assertIsNotNone(hop, 'Hop adapter missing')
        self.assertTrue((HOP.parent / 'hop.conf').exists(), 'Hop bindings not implemented')
        self.assertIn('next-word-end', next(line for line in self.tmux('list-keys', '-T', 'copy-mode-vi').splitlines() if line.split()[3] == 'e'))
        os.write(self.master, b'\x01ew')
        self.wait_screen('38;2;209;142;194')
        os.write(self.master, b's')
        self.wait_for(lambda: self.state() == ('copy-mode', (0, 6, 0)))
        os.write(self.master, b'vlllly')
        self.wait_for(lambda: self.tmux('show-buffer') == 'beta ')
        self.assertIn('select-pane -D', self.tmux('list-keys', '-T', 'prefix'))
        self.assertIn('select-pane -t :.+', self.tmux('list-keys', '-T', 'prefix'))

    def test_cancel_restores_normal_mode(self):
        proc = self.start()
        self.wait_screen('38;2;209;142;194')
        os.write(self.master, b'\x1b')
        self.finish(proc)
        self.assertEqual(self.state()[0], '')

    def test_cancel_preserves_existing_copy_cursor_and_selection(self):
        self.tmux('copy-mode', '-t', self.pane)
        self.tmux('send', '-t', self.pane, '-X', 'cursor-up')
        self.tmux('send', '-t', self.pane, '-X', 'start-of-line')
        self.tmux('send', '-t', self.pane, '-X', 'begin-selection')
        self.tmux('send', '-t', self.pane, '-X', 'cursor-right')
        self.assertEqual(self.tmux('display', '-p', '-t', self.pane, '#{selection_present}').strip(), '1')
        before = self.state()
        proc = self.start()
        self.wait_screen('38;2;209;142;194')
        os.write(self.master, b'\x03')
        self.finish(proc)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.tmux('display', '-p', '-t', self.pane, '#{selection_present}').strip(), '1')

    def test_pattern_binding_handles_invalid_regex_then_case_insensitive_match(self):
        self.assertTrue((HOP.parent / 'hop.conf').exists(), 'Hop bindings not implemented')
        os.write(self.master, b'\x01e/')
        self.wait_screen('Pattern:')
        os.write(self.master, b'[\r')
        self.wait_screen('Invalid pattern')
        os.write(self.master, b'\x7fBETA\r')
        self.wait_for(lambda: self.state() == ('copy-mode', (0, 6, 0)))

    def test_pattern_text_is_never_evaluated_as_shell_or_tmux_format(self):
        malicious = "'$(touch X)`x`#{pane_id}"
        self.fixture.write_text('import time\nprint(' + repr(malicious + ' ' + malicious) + ', flush=True)\ntime.sleep(120)')
        self.tmux('respawn-pane', '-k', '-t', self.pane, sys.executable, str(self.fixture))
        self.wait_for(lambda: malicious[:20] in self.tmux('capturep', '-p', '-t', self.pane))
        proc = self.start('pattern')
        self.wait_screen('Pattern:')
        import re
        os.write(self.master, (re.escape(malicious) + '\r').encode())
        self.wait_screen('38;2;209;142;194')
        os.write(self.master, b'a')
        self.finish(proc)
        self.assertEqual(self.state(), ('copy-mode', (0, 0, 0)))
        self.assertFalse((self.root / 'X').exists())
        self.assertFalse((HOP.parent / 'X').exists())

    def test_wide_characters_and_wrapped_rows_land_on_cell_coordinates(self):
        self.fixture.write_text("import time\nprint('界 alpha e\\u0301clair', flush=True)\nprint('x' * 70 + ' target', flush=True)\ntime.sleep(120)")
        self.tmux('respawn-pane', '-k', '-t', self.pane, sys.executable, str(self.fixture))
        self.wait_for(lambda: 'target' in self.tmux('capturep', '-p', '-t', self.pane))
        for pattern, point in [('alpha', (0, 3, 0)), ('clair', (0, 10, 0)), ('target', (2, 1, 0))]:
            proc = self.start('pattern')
            self.wait_screen('Pattern:')
            os.write(self.master, (pattern + '\r').encode())
            self.finish(proc)
            self.assertEqual(self.state(), ('copy-mode', point))
            self.tmux('send', '-t', self.pane, '-X', 'cancel')

    def test_zoom_and_offset_split_leave_layout_intact(self):
        second = self.tmux('split-window', '-h', '-P', '-F', '#{pane_id}', '-t', self.pane, 'sleep 120').strip()
        self.tmux('swap-pane', '-s', self.pane, '-t', second)
        self.tmux('select-pane', '-t', self.pane)
        before = self.tmux('display', '-p', '-t', self.pane, '#{window_layout}')
        for zoom in (False, True):
            if zoom:
                self.tmux('resize-pane', '-Z', '-t', self.pane)
            proc = self.start()
            self.wait_screen('38;2;209;142;194')
            os.write(self.master, b's')
            self.finish(proc)
            self.assertEqual(self.state()[1][:2], (0, 6))
            self.assertEqual(self.tmux('display', '-p', '-t', self.pane, '#{window_zoomed_flag}').strip(), str(int(zoom)))
            self.tmux('send', '-t', self.pane, '-X', 'cancel')
            if zoom:
                self.tmux('resize-pane', '-Z', '-t', self.pane)
            self.assertEqual(self.tmux('display', '-p', '-t', self.pane, '#{window_layout}'), before)

    def test_scrolled_frozen_viewport_survives_new_output(self):
        self.fixture.write_text("import time\nfor i in range(60): print('line%02d alpha beta' % i, flush=True)\nwhile True:\n time.sleep(.1)\n print('new output', flush=True)")
        self.tmux('respawn-pane', '-k', '-t', self.pane, sys.executable, str(self.fixture))
        self.wait_for(lambda: 'line59' in self.tmux('capturep', '-p', '-t', self.pane))
        self.tmux('copy-mode', '-t', self.pane)
        self.tmux('send', '-t', self.pane, '-X', 'page-up')
        self.tmux('send', '-t', self.pane, '-X', 'top-line')
        self.tmux('send', '-t', self.pane, '-X', 'start-of-line')
        before = self.state()
        capture = self.tmux('capturep', '-M', '-p', '-t', self.pane)
        proc = self.start('pattern')
        self.wait_screen('Pattern:')
        time.sleep(.3)
        os.write(self.master, b'alpha\r')
        self.wait_screen('38;2;209;142;194')
        os.write(self.master, b'a')
        self.finish(proc)
        self.assertEqual(self.state()[1][:2], (0, 7))
        self.assertGreater(self.state()[1][2], 0)
        self.assertEqual(self.tmux('capturep', '-M', '-p', '-t', self.pane).splitlines()[0], capture.splitlines()[0])
        self.assertEqual(before[0], 'copy-mode')

    def test_external_popup_close_and_resize_cancel_without_leaks(self):
        for resize in (False, True):
            proc = self.start()
            self.wait_screen('38;2;209;142;194')
            if resize:
                fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', 18, 60, 0, 0))
                os.kill(self.client.pid, signal.SIGWINCH)
            else:
                self.tmux('display-popup', '-C', '-c', self.client_name)
            self.finish(proc)
            self.assertEqual(self.state()[0], '')

    def test_no_match_can_be_edited_and_empty_input_cancels(self):
        proc = self.start('pattern')
        self.wait_screen('Pattern:')
        os.write(self.master, b'notpresent\r')
        self.wait_screen('No matches')
        os.write(self.master, b'\x15\r')
        self.finish(proc)
        self.assertEqual(self.state()[0], '')

    def test_client_disconnect_cleans_up_capture_and_mode(self):
        proc = self.start()
        self.wait_screen('38;2;209;142;194')
        self.tmux('detach-client', '-t', self.client_name)
        self.finish(proc)
        self.assertEqual(self.state()[0], '')

    def test_overlay_crash_closes_popup_and_restores_mode(self):
        proc = self.start()
        self.wait_screen('38;2;209;142;194')
        processes = subprocess.check_output(['ps', '-axo', 'pid=,command='], text=True)
        matches = [int(line.split()[0]) for line in processes.splitlines()
                   if Path(line.strip().split(maxsplit=1)[1].split()[0]).name.lower().startswith('python')
                   and ' overlay ' in line and str(self.root / 'tmux-hop-') in line]
        self.assertEqual(len(matches), 1)
        os.kill(matches[0], signal.SIGKILL)
        self.finish(proc)
        self.assertEqual(self.state()[0], '')

    def test_empty_pane_has_no_targets_from_copy_mode_position_indicator(self):
        self.fixture.write_text('import time\ntime.sleep(120)')
        self.tmux('respawn-pane', '-k', '-t', self.pane, sys.executable, str(self.fixture))
        self.wait_for(lambda: 'alpha' not in self.tmux('capturep', '-p', '-t', self.pane))
        proc = self.start()
        self.finish(proc)
        self.assertEqual(self.state()[0], '')

    def test_changed_viewport_rejects_stale_target(self):
        self.attach_second_client()
        self.fixture.write_text("import time\nfor i in range(100): print('line%03d alpha beta' % i, flush=True)\ntime.sleep(120)")
        self.tmux('respawn-pane', '-k', '-t', self.pane, sys.executable, str(self.fixture))
        self.wait_for(lambda: 'line099' in self.tmux('capturep', '-p', '-t', self.pane))
        self.tmux('copy-mode', '-t', self.pane)
        proc = self.start('pattern')
        self.wait_screen('Pattern:')
        self.tmux('send', '-t', self.pane, '-X', 'page-up')
        changed = self.state()
        os.write(self.master, b'line085\r')
        self.finish(proc)
        self.assertEqual(self.state(), changed)

    def test_cancel_preserves_another_clients_changed_selection(self):
        self.attach_second_client()
        proc = self.start()
        self.wait_screen('38;2;209;142;194')
        self.tmux('send', '-t', self.pane, '-X', 'top-line')
        self.tmux('send', '-t', self.pane, '-X', 'start-of-line')
        self.tmux('send', '-t', self.pane, '-X', 'begin-selection')
        self.tmux('send', '-t', self.pane, '-X', '-N', '6', 'cursor-right')
        changed = self.state()
        os.write(self.master, b'\x1b')
        self.finish(proc)
        self.assertEqual(self.state(), changed)
        self.assertEqual(self.tmux('display', '-p', '-t', self.pane, '#{selection_active}').strip(), '1')

    def test_another_client_cannot_start_hop_on_same_pane(self):
        second_client = self.attach_second_client()
        first = self.start()
        self.wait_screen('38;2;209;142;194')
        second = self.start(client=second_client)
        self.wait_for(lambda: second.poll() is not None, timeout=1)
        self.assertEqual(second.returncode, 0)
        self.assertIsNone(first.poll())
        os.write(self.master, b'\x1b')
        self.finish(first)

    def test_width_mismatch_restores_existing_cursor_and_selection(self):
        self.tmux('set', '-s', 'codepoint-widths[0]', 'U+754C=1')
        self.fixture.write_text("import time\nprint('界 alpha beta', flush=True)\ntime.sleep(120)")
        self.tmux('respawn-pane', '-k', '-t', self.pane, sys.executable, str(self.fixture))
        self.wait_for(lambda: 'alpha beta' in self.tmux('capturep', '-p', '-t', self.pane))
        self.tmux('copy-mode', '-t', self.pane)
        self.tmux('send', '-t', self.pane, '-X', 'top-line')
        self.tmux('send', '-t', self.pane, '-X', 'start-of-line')
        self.tmux('send', '-t', self.pane, '-X', 'begin-selection')
        before = self.state()
        proc = self.start('pattern')
        self.wait_screen('Pattern:')
        os.write(self.master, b'alpha\r')
        self.finish(proc)
        self.assertEqual(self.state(), before)
        self.tmux('send', '-t', self.pane, '-X', 'copy-selection')
        self.assertEqual(self.tmux('show-buffer'), '界')

    def test_second_invocation_does_not_replace_active_popup(self):
        first = self.start()
        self.wait_screen('38;2;209;142;194')
        second = self.start()
        self.assertEqual(second.wait(timeout=3), 0)
        self.assertIsNone(first.poll())
        os.write(self.master, b'\x1b')
        self.finish(first)


if __name__ == '__main__':
    unittest.main()