import fcntl
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
HOP = ROOT / 'home/.config/tmux/hop/hop.py'


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
        os.write(self.master, b'\x01ew')
        self.wait_screen('38;2;209;142;194')
        os.write(self.master, b's')
        self.wait_for(lambda: self.state() == ('copy-mode', (0, 6, 0)))
        os.write(self.master, b'vlllly')
        self.wait_for(lambda: self.tmux('show-buffer') == 'beta ')

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
        os.write(self.master, b'\x01e/')
        self.wait_screen('Pattern:')
        os.write(self.master, b'[\r')
        self.wait_screen('Invalid pattern')
        os.write(self.master, b'\x7fBETA\r')
        self.wait_for(lambda: self.state() == ('copy-mode', (0, 6, 0)))


if __name__ == '__main__':
    unittest.main()