# since zshenv sets $ZDOTDIR, it needs to be symlinked directly from
# $HOME/.zshenv
export XDG_CONFIG_HOME=${HOME}/.config
ZDOTDIR=${XDG_CONFIG_HOME}/zsh

# Start configuration added by Zim install {{{
#
# User configuration sourced by all invocations of the shell
#

# Define Zim location
: ${ZIM_HOME=${ZDOTDIR:-${HOME}}/.zim}
# }}} End configuration added by Zim install
