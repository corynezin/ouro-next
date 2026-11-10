Pod::Spec.new do |s|
  s.name           = 'LockWindow'
  s.version        = '1.0.0'
  s.summary        = 'The Face ID cover in its own window, above sheets and alerts.'
  s.author         = 'Ouro'
  s.homepage       = 'https://example.com/ouro'
  s.license        = 'UNLICENSED'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
