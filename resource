#!/usr/bin/ruby
#
# This file is part of centurio.work/plan.
#
# centurio.work/plan is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by the Free
# Software Foundation, either version 3 of the License, or (at your option) any
# later version.
#
# centurio.work/plan is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
# FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for
# more details.
#
# You should have received a copy of the GNU General Public License along with
# centurio.work/plan (file COPYING in the main directory). If not, see
# <http://www.gnu.org/licenses/>.

require 'rubygems'
require 'riddl/server'
require 'net/smtp'

class DoGet < Riddl::Implementation #{{{
  def response
    dir = File.join(__dir__,'data',Riddl::Protocols::Utils::escape(@r[0] + '//' + @r[1..-1].join('/')))
    file = File.join(__dir__,'data',Riddl::Protocols::Utils::escape(@r[0] + '//' + @r[1..-2].join('/')),@r.last)
    case @r.last
      when 'symbol.svg'
        return Riddl::Parameter::Complex.new('svg','image/svg+xml',File.read(file)) if File.exists?(file)
      when 'schema.rng'
        return Riddl::Parameter::Complex.new('rng','text/xml',File.read(file)) if File.exists?(file)
      else
        return Riddl::Parameter::Complex.new('exists','text/plain','There is no means of proving it is preferable to be than not to be. (Emil Cioran)') if Dir.exists?(dir)
    end
    @status = 404
    return Riddl::Parameter::Complex.new('exists','text/plain','Existence really is an imperfect tense that never becomes a present. (Friedrich Nietzsche)')
  end
end #}}}

options = {
  :host => 'centurio.work',
  :port => 9303,
  :secure => false
}

Riddl::Server.new(File.join(__dir__,'/resource.xml'), options) do
  accessible_description true
  cross_site_xhr true

  on resource do
    on resource do
      run DoGet if get
    end
  end
end.loop!
