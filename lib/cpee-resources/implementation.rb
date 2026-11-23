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
require 'fileutils'
require 'open3'
require 'riddl/server'

module CPEE
  module Resources
    GIT_LOCK = Mutex.new
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
    def self::author(h) #{{{
      # like in cpee-model-management, from the DN of the authentication
      dn = h['DN'] ? h['DN'].split(',').map{ |e| e.split('=',2) }.to_h : {}
      dn['GN'] && dn['SN'] ? dn['GN'] + ' ' + dn['SN'] : 'Christine Ashcreek'
    end #}}}
    def self::git_init(data) #{{{
      # data has to be a repository of its own, one around it (e.g. the code
      # with the default data) does not count
      root = File.realpath(data)
      top, status = Open3.capture2e('git','rev-parse','--show-toplevel',chdir: root)
      return if status.success? && top.strip == root
      Open3.capture2e('git','init','-q',chdir: root)
      Open3.capture2e('git','add','-A',chdir: root)
      Open3.capture2e('git','-c','user.name=Christine Ashcreek','-c','user.email=dev@null.com','commit','-q','-m','initial',chdir: root)
      puts "➡ Data directory #{root} is now a git repository"
    end #}}}
    def self::git_commit(data,path,h,op) #{{{
      # commits the change of path (file or directory, also when deleted) in
      # the background, data is a repository (git_init)
      author = CPEE::Resources::author(h)
      Thread.new do
        GIT_LOCK.synchronize do
          root = File.realpath(data)
          abs = File.join(File.realpath(File.dirname(path)),File.basename(path))
          msg = op + ' ' + abs.delete_prefix(root + '/')
          Open3.capture2e('git','add','-A','--',abs,chdir: root)
          Open3.capture2e('git','-c','user.name=' + author,'-c','user.email=dev@null.com','commit','-q','-m',msg,'--',abs,chdir: root)
        end
      rescue => e
        warn 'git commit of ' + path + ' failed: ' + e.message
      end
    end #}}}
    def self::linked(file) #{{{
      # the name of the global schema or symbol that file links to, false if it is no link
      File.symlink?(file) ? File.basename(File.readlink(file)) : false
    end #}}}
    def self::notify(conns,kind,op,name,content=nil) #{{{
      what = { :kind => kind, :op => op, :name => name }
      what[:content] = content unless content.nil?
      what = JSON::generate(what)
      conns.each do |e|
        e.send what unless e.closed?
      end
    end #}}}
    class Events < Riddl::SSEImplementation #{{{
      def onopen
        @conns = @a[0]
        @conns << self
      end
      def onclose
        @conns.delete(self)
      end
    end #}}}

    class DoPutFile < Riddl::Implementation #{{{
      def response
        data = @a[1]
        name = @r[-1]
        file = File.join(data,@a[0],Riddl::Protocols::Utils::escape(name))
        op = File.exist?(file) ? 'update' : 'create'
        FileUtils.mkdir_p(File.dirname(file))
        File.open(file,'wb') do |f|
          IO.copy_stream(@p[0].value,f)
        end
        CPEE::Resources::notify(@a[2],@a[0],op,name,File.read(file)) if @a[2]
        CPEE::Resources::git_commit(data,file,@h,op)
        nil
      end
    end #}}}
    class DoPutDescription < Riddl::Implementation #{{{
      def response
        data = @a[1]
        dir = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-3]))
        unless Dir.exist?(dir)
          @status = 404
          return Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
        ddir = File.join(dir,'descriptions')
        Dir.mkdir(ddir) unless Dir.exist?(ddir)
        File.open(File.join(ddir,@r[-1]),'wb') do |f|
          IO.copy_stream(@p[0].value,f) if @p[0]
        end
        CPEE::Resources::notify(@a[2],@a[0],'update',@r[-3]) if @a[2]
        CPEE::Resources::git_commit(data,File.join(ddir,@r[-1]),@h,'update')
        nil
      end
    end #}}}
    class DoDeleteDescription < Riddl::Implementation #{{{
      def response
        data = @a[1]
        ddir = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-3]),'descriptions')
        file = File.join(ddir,@r[-1])
        unless File.exist?(file)
          @status = 404
          return Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
        File.delete(file)
        # without parts the endpoint has no description at all (see DoDescList)
        Dir.rmdir(ddir) if Dir.empty?(ddir)
        CPEE::Resources::notify(@a[2],@a[0],'update',@r[-3]) if @a[2]
        CPEE::Resources::git_commit(data,Dir.exist?(ddir) ? file : ddir,@h,'delete')
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
        CPEE::Resources::notify(@a[3],@a[0],'update',@r[-2]) if @a[3]
        CPEE::Resources::git_commit(data,file,@h,'update')
        nil
      end
    end #}}}
    class DoDeleteEndpointFile < Riddl::Implementation #{{{
      def response
        data = @a[1]
        file = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-2]),@r[-1])
        if File.exist?(file) || File.symlink?(file)
          File.delete(file)
          CPEE::Resources::notify(@a[2],@a[0],'update',@r[-2]) if @a[2]
          CPEE::Resources::git_commit(data,file,@h,'delete')
          nil
        else
          @status = 404
          Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
      end
    end #}}}
    class DoDeleteFile < Riddl::Implementation #{{{
      def response
        data = @a[1]
        file = File.join(data,@a[0],*(@r[@a[2]].map{|e| Riddl::Protocols::Utils::escape(e)}))
        if File.exist?(file) || File.symlink?(file)
          File.delete(file)
          CPEE::Resources::notify(@a[3],@a[0],'delete',@r[-1]) if @a[3]
          CPEE::Resources::git_commit(data,file,@h,'delete')
          nil
        else
          @status = 404
          Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
      end
    end #}}}
    class DoProperties < Riddl::Implementation #{{{
      def response
        data = @a[1]
        dir = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-2]))
        file = File.join(dir,'properties.json')
        if Dir.exist?(dir)
          props = File.exist?(file) ? JSON.parse(File.read(file)) : {}
          props['global-schema'] = CPEE::Resources::linked(File.join(dir,'schema.rng'))
          props['global-symbol'] = CPEE::Resources::linked(File.join(dir,'symbol.svg'))
          Riddl::Parameter::Complex.new('json','application/json',JSON.generate(props))
        else
          @status = 404
          Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
      end
    end #}}}
    class DoGetProperty < Riddl::Implementation #{{{
      def response
        data = @a[1]
        dir = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-3]))
        file = File.join(dir,'properties.json')
        key = @r[-1]
        props = File.exist?(file) ? JSON.parse(File.read(file)) : {}
        props['global-schema'] = CPEE::Resources::linked(File.join(dir,'schema.rng'))
        props['global-symbol'] = CPEE::Resources::linked(File.join(dir,'symbol.svg'))
        if Dir.exist?(dir) && props.key?(key)
          Riddl::Parameter::Complex.new('value','text/plain',props[key].to_s)
        else
          @status = 404
          Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
      end
    end #}}}
    class DoPutProperty < Riddl::Implementation #{{{
      def response
        data = @a[1]
        dir = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-3]))
        file = File.join(dir,'properties.json')
        key = @r[-1]
        unless Dir.exist?(dir)
          @status = 404
          return Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
        props = File.exist?(file) && !File.read(file).strip.empty? ? JSON.parse(File.read(file)) : {}
        props[key] = @p[0].value
        File.write(file,JSON.pretty_generate(props))
        CPEE::Resources::notify(@a[2],@a[0],'update',@r[-3],File.read(file)) if @a[2]
        CPEE::Resources::git_commit(data,file,@h,'update')
        nil
      end
    end #}}}
    class DoDeleteProperty < Riddl::Implementation #{{{
      def response
        data = @a[1]
        dir = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-3]))
        file = File.join(dir,'properties.json')
        key = @r[-1]
        props = File.exist?(file) ? JSON.parse(File.read(file)) : {}
        if props.key?(key)
          props.delete(key)
          File.write(file,JSON.pretty_generate(props))
          CPEE::Resources::notify(@a[2],@a[0],'update',@r[-3],File.read(file)) if @a[2]
          CPEE::Resources::git_commit(data,file,@h,'update')
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
        File.write(File.join(dir,'properties.json'),'{}')
        CPEE::Resources::notify(@a[2],@a[0],'create',@p[0].value) if @a[2]
        CPEE::Resources::git_commit(data,dir,@h,'create')
        @status = 201
        nil
      rescue Errno::EEXIST
        @status = 409
        Riddl::Parameter::Complex.new('exists','text/plain','Endpoint already exists.')
      end
    end #}}}
    class DoCopyEndpoint < Riddl::Implementation #{{{
      # with all its files, links to global schemas and symbols stay links
      def response
        data = @a[1]
        name = @p[0].value
        src = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@p[1].value))
        dst = File.join(data,@a[0],Riddl::Protocols::Utils::escape(name))
        unless Dir.exist?(src)
          @status = 404
          return Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
        if File.exist?(dst)
          @status = 409
          return Riddl::Parameter::Complex.new('exists','text/plain','Endpoint already exists.')
        end
        FileUtils.cp_r(src,dst)
        CPEE::Resources::notify(@a[2],@a[0],'create',name) if @a[2]
        CPEE::Resources::git_commit(data,dst,@h,'create')
        @status = 201
        nil
      end
    end #}}}
    class DoPutProperties < Riddl::Implementation #{{{
      # the whole properties.json, without what DoProperties adds
      def response
        data = @a[1]
        dir = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-2]))
        file = File.join(dir,'properties.json')
        unless Dir.exist?(dir)
          @status = 404
          return Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
        value = @p[0].value
        value = value.read if value.respond_to?(:read)
        props = JSON.parse(value) rescue nil
        unless props.is_a?(Hash)
          @status = 400
          return nil
        end
        props.delete('global-schema')
        props.delete('global-symbol')
        File.write(file,JSON.pretty_generate(props))
        CPEE::Resources::notify(@a[2],@a[0],'update',@r[-2],File.read(file)) if @a[2]
        CPEE::Resources::git_commit(data,file,@h,'update')
        nil
      end
    end #}}}
    class DoDeleteEndpoint < Riddl::Implementation #{{{
      def response
        data = @a[1]
        dir = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-1]))
        if Dir.exist?(dir)
          FileUtils.rm_r(dir)
          CPEE::Resources::notify(@a[2],@a[0],'delete',@r[-1]) if @a[2]
          CPEE::Resources::git_commit(data,dir,@h,'delete')
          nil
        else
          @status = 404
          Riddl::Parameter::Complex.new('exists','text/plain',NOT_FOUND)
        end
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
          names = Dir.glob(File.join(dir,'*')).map{ |f| File.basename(f) } | (@a[5] || [])
          names.sort.each do |n|
            next if @a[4] && !@a[4].include?(n)
            doc.root.add('resource',n)
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
            next if Dir.glob(File.join(f,'{endpoint,functionality,output}.md')).empty?
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
      opts[:sse_keepalive_frequency] ||= 10
      opts[:receivers] = []

      Proc.new do
        parallel do
          EM.add_periodic_timer(opts[:sse_keepalive_frequency]) do
            opts[:receivers].each do |sse|
              sse.send_with_id('heartbeat', '42') unless sse&.closed?
            end
          end
        end

        startup do
          CPEE::Resources::git_init(opts[:data_dir])
        end

        on resource do
          on resource 'events' do
            run Events, opts[:receivers] if sse
          end
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
              run DoPutFile, 'symbols', opts[:data_dir], opts[:receivers] if put 'symbol'
              run DoDeleteFile, 'symbols', opts[:data_dir], (-1..-1), opts[:receivers] if delete
            end
          end
          on resource 'schemas' do
            run DoList, 'schemas', opts[:data_dir] if get
            on resource '[a-z][a-zA-Z0-9_-]*\.rng' do
              run DoFile, 'schemas', opts[:data_dir], (-1..-1), 'rng', 'text/xml' if get
              run DoPutFile, 'schemas', opts[:data_dir], opts[:receivers] if put 'schema'
              run DoDeleteFile, 'schemas', opts[:data_dir], (-1..-1), opts[:receivers] if delete
            end
          end
          on resource 'endpoints' do
            run DoDescList, 'endpoints', opts[:data_dir] if get 'dfilter'
            run DoList, 'endpoints', opts[:data_dir] if get
            run DoCopyEndpoint, 'endpoints', opts[:data_dir], opts[:receivers] if post 'endpoint-copy'
            run DoNewEndpoint, 'endpoints', opts[:data_dir], opts[:receivers] if post 'endpoint'
            on resource do
              run DoList, 'endpoints', opts[:data_dir], (-1..-1), true, %w{schema.rng symbol.svg properties.json descriptions}, %w{properties.json} if get
              run DoDeleteEndpoint, 'endpoints', opts[:data_dir], opts[:receivers] if delete
              on resource 'symbol.svg' do
                run DoFile, 'endpoints', opts[:data_dir], (-2..-1), 'svg', 'image/svg+xml'  if get
                run DoPutEndpointFile, 'endpoints', opts[:data_dir], 'symbols', opts[:receivers] if put 'endpoint-symbol'
                run DoDeleteEndpointFile, 'endpoints', opts[:data_dir], opts[:receivers] if delete
              end
              on resource 'schema.rng' do
                run DoFile, 'endpoints', opts[:data_dir], (-2..-1), 'rng', 'text/xml' if get
                run DoPutEndpointFile, 'endpoints', opts[:data_dir], 'schemas', opts[:receivers] if put 'endpoint-schema'
                run DoDeleteEndpointFile, 'endpoints', opts[:data_dir], opts[:receivers] if delete
              end
              on resource 'properties.json' do
                run DoProperties, 'endpoints', opts[:data_dir] if get
                run DoPutProperties, 'endpoints', opts[:data_dir], opts[:receivers] if put 'properties'
                on resource do
                  run DoGetProperty, 'endpoints', opts[:data_dir] if get
                  run DoPutProperty, 'endpoints', opts[:data_dir], opts[:receivers] if put 'property'
                  run DoDeleteProperty, 'endpoints', opts[:data_dir], opts[:receivers] if delete
                end
              end
              on resource 'descriptions' do
                run DoList, 'endpoints', opts[:data_dir], (-2..-1), true, %w{functionality.md output.md endpoint.md} if get
                on resource 'functionality.md' do
                  run DoFile, 'endpoints', opts[:data_dir], (-3..-1), 'markdown', 'text/markdown' if get
                  run DoPutDescription, 'endpoints', opts[:data_dir], opts[:receivers] if put 'description-file'
                  run DoDeleteDescription, 'endpoints', opts[:data_dir], opts[:receivers] if delete
                end
                on resource 'output.md' do
                  run DoFile, 'endpoints', opts[:data_dir], (-3..-1), 'markdown', 'text/markdown' if get
                  run DoPutDescription, 'endpoints', opts[:data_dir], opts[:receivers] if put 'description-file'
                  run DoDeleteDescription, 'endpoints', opts[:data_dir], opts[:receivers] if delete
                end
                on resource 'endpoint.md' do
                  run DoFile, 'endpoints', opts[:data_dir], (-3..-1), 'markdown', 'text/markdown' if get
                  run DoPutDescription, 'endpoints', opts[:data_dir], opts[:receivers] if put 'description-file'
                  run DoDeleteDescription, 'endpoints', opts[:data_dir], opts[:receivers] if delete
                end
              end
            end
          end
        end
      end
    end
  end
end
