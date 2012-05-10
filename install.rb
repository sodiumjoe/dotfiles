#!/usr/bin/env ruby

require 'fileutils'

# from http://errtheblog.com/posts/89-huba-huba
home = File.expand_path('~')

`git submodule init`
`git submodule update`

Dir['*'].each do |file|
  next if file =~ /install.rb/
  target = File.join(home, ".#{file}")
  if File.exists?(target)
    File.directory?(target) ? FileUtils.rm_rf(target) : File.unlink(target)
  end
  `ln -s #{File.expand_path file} #{target}`
end

%w(env dir_aliases).each {|f| `touch #{home}/.#{f}` }
`mkdir #{home}/.zsh_cache` unless File.exists?("#{home}/.zsh_cache")
