This is my dotfiles repo. There are many like it but this one is mine.

# Install

```bash
xcode-select --install
cd ~
git clone --recursive https://github.com/sodiumjoe/dotfiles.git .dotfiles
cd .dotfiles
./bootstrap.sh
./brew.sh
./macos
```

- [Alacritty terminfo](https://github.com/alacritty/alacritty/blob/master/INSTALL.md#terminfo)
- filevault
- caps -> ctrl
- generate ssh keys
- https://www.rustup.rs/

# Update

- `zimfw update`
- `zimfw upgrade`
- `brew update`
- `brew upgrade`

```bash
cd ~/.dotfiles
fast-theme zsh/sodium
```
