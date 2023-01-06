if [[ -a /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -a /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi
