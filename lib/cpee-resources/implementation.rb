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

require 'rubygems'
require 'riddl/server'

module CPEE
  module Resources

    SERVER = File.expand_path(File.join(__dir__,'resources.xml'))

    class DoExists < Riddl::Implementation #{{{
      def response
        data = @a[1]
        dir = File.join(data,@a[0],Riddl::Protocols::Utils::escape(@r[-1]))
        if Dir.exist?(dir)
          return Riddl::Parameter::Complex.new('exists','text/xml') do
            doc = XML::Smart::string('<resource/>')
            doc.root.add('schema','schema.rng') if File.exist?(File.join(dir,'schema.rng'))
            doc.root.add('symbol','symbol.svg') if File.exist?(File.join(dir,'symbol.svg'))
            doc.root.add('properties','properties.json') if File.exist?(File.join(dir,'properties.json'))
            doc.to_s
          end
        else
          @status = 404
          Riddl::Parameter::Complex.new('exists','text/plain','Existence really is an imperfect tense that never becomes a present. (Friedrich Nietzsche)')
        end
      end
    end #}}}
    class DoModExists < Riddl::Implementation #{{{
      def response
        data = @a[1]
        dir = File.join(data,'modifiers',Riddl::Protocols::Utils::escape(@r[-2]),Riddl::Protocols::Utils::escape(@r[-1]))
        if Dir.exist?(dir)
          Riddl::Parameter::Complex.new('exists','text/xml') do
            doc = XML::Smart::string('<resource/>')
            doc.root.add('patch','patch.xml') if File.exist?(File.join(dir,'patch.xml'))
            doc.root.add('unpatch','unpatch.xml') if File.exist?(File.join(dir,'unpatch.xml'))
            doc.root.add('condition','condition.json') if File.exist?(File.join(dir,'condition.json'))
            doc.root.add('ui','ui.rng') if File.exist?(File.join(dir,'ui.rng'))
            doc.to_s
          end
        else
          @status = 404
          Riddl::Parameter::Complex.new('exists','text/plain','Existence really is an imperfect tense that never becomes a present. (Friedrich Nietzsche)')
        end
      end
    end #}}}
    class DoFile < Riddl::Implementation #{{{
      def response
        data = @a[1]
        file = File.join(data,@a[0],*(@r[@a[2]].map{|e| Riddl::Protocols::Utils::escape(e)}))
        if File.exist?(file)
          Riddl::Parameter::Complex.new(@a[3],@a[4],File.read(file)) if File.exist?(file)
        else
          @status = 404
          Riddl::Parameter::Complex.new('exists','text/plain','Existence really is an imperfect tense that never becomes a present. (Friedrich Nietzsche)')
        end
      end
    end #}}}
    class DoList < Riddl::Implementation #{{{
      def response
        data = @a[1]
        @a[2] ||= 0...0
        dir = File.join(data,@a[0],*(@r[@a[2]].map{|e| Riddl::Protocols::Utils::escape(e)}))
        return Riddl::Parameter::Complex.new('list','text/xml') do
          doc = XML::Smart::string('<resources/>')
          Dir.glob(File.join(dir,'*')).sort.each do |f|
           doc.root.add('resource',File.basename(f))
          end
          doc.to_s
        end
      end
    end #}}}

    def self::implementation(opts)
      opts[:data_dir]           ||= File.expand_path(File.join(__dir__,'data'))

      Proc.new do
        on resource do
          on resource 'modifiers' do
            run DoList, 'modifiers', opts[:data-dir] if get
            on resource do
              run DoList, 'modifiers', opts[:data-dir], (-1..-1) if get
              on resource do
                run DoModExists, 'modifiers', opts[:data-dir] if get
                on resource 'patch.xml' do
                  run DoFile, 'modifiers', opts[:data-dir], (-3..-1), 'testset', 'text/xml' if get
                end
                on resource 'unpatch.xml' do
                  run DoFile, 'modifiers', opts[:data-dir], (-3..-1), 'testset', 'text/xml' if get
                end
                on resource 'condition.json' do
                  run DoFile, 'modifiers', opts[:data-dir], (-3..-1), 'json', 'application/json' if get
                end
                on resource 'ui.rng' do
                  run DoFile, 'modifiers', opts[:data-dir], (-3..-1), 'rng', 'text/xml' if get
                end
              end
            end
          end
          on resource 'endpoints' do
            run DoList, 'endpoints', opts[:data-dir] if get
            on resource do
              run DoExists, 'endpoints', opts[:data-dir] if get
              on resource 'symbol.svg' do
                run DoFile, 'endpoints', opts[:data-dir], (-2..-1), 'svg', 'image/svg+xml'  if get
              end
              on resource 'schema.rng' do
                run DoFile, 'endpoints', opts[:data-dir], (-2..-1), 'rng', 'text/xml' if get
              end
              on resource 'properties.json' do
                run DoFile, 'endpoints', opts[:data-dir], (-2..-1), 'json', 'application/json' if get
              end
            end
          end
        end
      end
    end
  end
end
