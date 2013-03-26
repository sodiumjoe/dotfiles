#!/usr/bin/env ruby

require 'fileutils'

home = File.expand_path('~')

`git submodule init`
`git submodule update`

Dir['*'].each do |file|
  next if file =~ /install.rb/
  next if file =~ /\^\..*/ # ignore dotfiles
  next if file =~ /readme/i
  next if file =~ /Icon/i
  target = File.join(home, ".#{file}")
  if File.exists?(target)
    File.directory?(target) ? FileUtils.rm_rf(target) : File.unlink(target)
  end
  `ln -s #{File.expand_path file} #{target}`
end

%w(env dir_aliases).each {|f| `touch #{home}/.#{f}` }
`mkdir #{home}/.zsh_cache` unless File.exists?("#{home}/.zsh_cache")

 make .osx file executable and run it

if File.exists?('.osx')
  if !File.executable?('.osx')
    File.chmod(0774, '.osx')
  end
  system('sh ./.osx')
end

Dir['bin/*'].each do |file|
  if !File.executable?(file)
    File.chmod(0774, file)
  end
end
