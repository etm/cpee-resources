#!/usr/bin/ruby
#
# This file is part of CPEE-RESOURCES.
#
# CPEE-RESOURCES is free software: you can redistribute it and/or modify it
# under the terms of the GNU Lesser General Public License as published by the
# Free Software Foundation, either version 3 of the License, or (at your
# option) any later version.
#
# CPEE-RESOURCES is distributed in the hope that it will be useful, but WITHOUT
# ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
# FOR A PARTICULAR PURPOSE.  See the GNU Lesser General Public License for more
# details.
#
# You should have received a copy of the GNU Lesser General Public License
# along with CPEE-RESOURCES (file LICENSE in the main directory). If not, see
# <http://www.gnu.org/licenses/>.

require 'json'
require 'riddl/server'

module CPEE
  module Resources

    SERVER = File.expand_path(File.join(__dir__,'implementation.xml'))
    NOT_FOUND = 'Existence really is an imperfect tense that never becomes a present. (Friedrich Nietzsche)'

    class DoFile < Riddl::Implementation #{{{
      def response
        data = @a[1]
        file = File.join(data,@a[0],*(@r[@a[2]].map{|e| Riddl::Protocols::Utils::escape(e)}))
        if File.exist?(file)
          Riddl::Parameter::Complex.new(@a[3],@a[4],File.read(file))
        else
          @status = 404
          Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
      end
    end #}}}
    class DoPutFile < Riddl::Implementation #{{{
      def response
        data = @a[1]
        name = @r[-1]
        file = File.join(data,@a[0],Riddl::Protocols::Utils::escape(name))
        File.open(file,'wb') do |f|
          IO.copy_stream(@p[0].value,f)
        end
        nil
      end
    end #}}}
    class DoPutEndpointFile < Riddl::Implementation #{{{
      def response
        data = @a[1]
        dir = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-2]))
        file = File.join(dir,@r[-1])
        unless Dir.exist?(dir)
          @status = 404
          return Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
        if @p[0].name == 'name'
          target = File.join('..','..',@a[2],@p[0].value)
          unless File.exist?(File.join(dir,target))
            @status = 404
            return Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
          end
          File.unlink(file) if File.symlink?(file) || File.exist?(file)
          File.symlink(target,file)
        else
          File.unlink(file) if File.symlink?(file)
          File.open(file,'wb') do |f|
            IO.copy_stream(@p[0].value,f)
          end
        end
        nil
      end
    end #}}}
    class DoDeleteFile < Riddl::Implementation #{{{
      def response
        data = @a[1]
        file = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-1]))
        if File.exist?(file)
          File.delete(file)
          nil
        else
          @status = 404
          Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
      end
    end #}}}
    class DoNewEndpoint < Riddl::Implementation #{{{
      def response
        data = @a[1]
        dir = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@p[0].value))
        Dir.mkdir(dir)
        @status = 201
        nil
      rescue Errno::EEXIST
        @status = 409
        Riddl::Parameter::Complex.new('exists','text/plain','Endpoint already exists.')
      end
    end #}}}
    class DoList < Riddl::Implementation #{{{
      def response
        data = @a[1]
        @a[2] ||= 0...0
        dir = File.join(data,@a[0],*(@r[@a[2]].map{|e| Riddl::Protocols::Utils::escape(e)}))
        if @a[3] && !Dir.exist?(dir)
          @status = 404
          return Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
        return Riddl::Parameter::Complex.new('list','text/xml') do
          doc = XML::Smart::string('<resources/>')
          Dir.glob(File.join(dir,'*')).sort.each do |f|
            next if @a[4] && !@a[4].include?(File.basename(f))
            doc.root.add('resource',File.basename(f))
          end
          doc.to_s
        end
      end
    end #}}}
    class DoDescList < Riddl::Implementation #{{{
      def response
        data = @a[1]
        @a[2] ||= 0...0
        dir = File.join(data,@a[0],*(@r[@a[2]].map{|e| Riddl::Protocols::Utils::escape(e)}))
        return Riddl::Parameter::Complex.new('list','text/xml') do
          doc = XML::Smart::string('<resources/>')
          Dir.glob(File.join(dir,'*','descriptions')).each do |f|
            n = doc.root.add('resource', 'endpoint' => File.basename(File.dirname(f)))
            n.add('endpoint', File.read(File.join(f,'endpoint.md'))) if File.exist?(File.join(f,'endpoint.md'))
            n.add('functionality', File.read(File.join(f,'functionality.md'))) if File.exist?(File.join(f,'functionality.md'))
            n.add('output', File.read(File.join(f,'output.md'))) if File.exist?(File.join(f,'output.md'))
          end
          doc.to_s
        end
      end
    end #}}}

    def self::implementation(opts)
      opts[:data_dir]           ||= File.expand_path(File.join(__dir__,'data'))

      Proc.new do
        on resource do
          run DoList, '', opts[:data_dir] if get
          on resource 'modifiers' do
            run DoList, 'modifiers', opts[:data_dir] if get
            on resource do
              run DoList, 'modifiers', opts[:data_dir], (-1..-1) if get
              on resource do
                run DoList, 'modifiers', opts[:data_dir], (-2..-1), true, %w{patch.xml unpatch.xml condition.json ui.rng} if get
                on resource 'patch.xml' do
                  run DoFile, 'modifiers', opts[:data_dir], (-3..-1), 'testset', 'text/xml' if get
                end
                on resource 'unpatch.xml' do
                  run DoFile, 'modifiers', opts[:data_dir], (-3..-1), 'testset', 'text/xml' if get
                end
                on resource 'condition.json' do
                  run DoFile, 'modifiers', opts[:data_dir], (-3..-1), 'json', 'application/json' if get
                end
                on resource 'ui.rng' do
                  run DoFile, 'modifiers', opts[:data_dir], (-3..-1), 'rng', 'text/xml' if get
                end
              end
            end
          end
          on resource 'symbols' do
            run DoList, 'symbols', opts[:data_dir] if get
            on resource '[a-z][a-zA-Z0-9_-]*\.svg' do
              run DoFile, 'symbols', opts[:data_dir], (-1..-1), 'svg', 'image/svg+xml' if get
              run DoPutFile, 'symbols', opts[:data_dir] if put 'symbol'
              run DoDeleteFile, 'symbols', opts[:data_dir] if delete
            end
          end
          on resource 'schemas' do
            run DoList, 'schemas', opts[:data_dir] if get
            on resource '[a-z][a-zA-Z0-9_-]*\.rng' do
              run DoFile, 'schemas', opts[:data_dir], (-1..-1), 'rng', 'text/xml' if get
              run DoPutFile, 'schemas', opts[:data_dir] if put 'schema'
              run DoDeleteFile, 'schemas', opts[:data_dir] if delete
            end
          end
          on resource 'endpoints' do
            run DoDescList, 'endpoints', opts[:data_dir] if get 'dfilter'
            run DoList, 'endpoints', opts[:data_dir] if get
            run DoNewEndpoint, 'endpoints', opts[:data_dir] if post 'endpoint'
            on resource do
              run DoList, 'endpoints', opts[:data_dir], (-1..-1), true, %w{schema.rng symbol.svg properties.json descriptions} if get
              on resource 'symbol.svg' do
                run DoFile, 'endpoints', opts[:data_dir], (-2..-1), 'svg', 'image/svg+xml'  if get
                run DoPutEndpointFile, 'endpoints', opts[:data_dir], 'symbols' if put 'endpoint-symbol'
              end
              on resource 'schema.rng' do
                run DoFile, 'endpoints', opts[:data_dir], (-2..-1), 'rng', 'text/xml' if get
                run DoPutEndpointFile, 'endpoints', opts[:data_dir], 'schemas' if put 'endpoint-schema'
              end
              on resource 'properties.json' do
                run DoFile, 'endpoints', opts[:data_dir], (-2..-1), 'json', 'application/json' if get
              end
              on resource 'descriptions' do
                run DoList, 'endpoints', opts[:data_dir], (-2..-1), true, %w{functionality.md output.md endpoint.md} if get
                on resource 'functionality.md' do
                  run DoFile, 'endpoints', opts[:data_dir], (-3..-1), 'markdown', 'text/markdown' if get
                end
                on resource 'output.md' do
                  run DoFile, 'endpoints', opts[:data_dir], (-3..-1), 'markdown', 'text/markdown' if get
                end
                on resource 'endpoint.md' do
                  run DoFile, 'endpoints', opts[:data_dir], (-3..-1), 'markdown', 'text/markdown' if get
                end
              end
            end
          end
        end
      end
    end
  end
end
