Gem::Specification.new do |s|
  s.name             = "cpee-resources"
  s.version          = "1.0.2"
  s.platform         = Gem::Platform::RUBY
  s.license          = "LGPL-3.0-or-later"
  s.summary          = "Resources list for the cloud process execution engine (cpee.org)"

  s.description      = "see http://cpee.org"

  s.files            = Dir['{server/**/*,tools/**/*,lib/**/*}'] + %w(LICENSE Rakefile cpee-resources.gemspec README.md AUTHORS)
  s.require_path     = 'lib'
  s.extra_rdoc_files = ['README.md']
  s.bindir           = 'tools'
  s.executables      = ['cpee-resources']

  s.required_ruby_version = '>=2.4.0'

  s.authors          = ['Juergen eTM Mangler','Ralph Vigne']

  s.email            = 'juergen.mangler@gmail.com'
  s.homepage         = 'http://cpee.org/'

  s.add_runtime_dependency 'riddl', '~> 1.0'
end
