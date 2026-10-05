# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Writes test values with Ruby's own Marshal.dump, with what each should
# decode to, the way test/generate/python.py does for Python.
#
#   ruby inspect/test/generate/ruby.rb

require 'json'

OUT = File.join(__dir__, '..', 'fixtures')
RUBY = "Ruby #{RUBY_VERSION}"

def text(s)
  t = s.dup.force_encoding('UTF-8')
  t.valid_encoding? ? t : nil
end

def cj(x)
  case x
  when nil then nil
  when true, false then x
  when Integer then { 'i' => x.to_s }
  when Float
    return { 'n' => 'NaN' } if x.nan?
    return { 'n' => x > 0 ? 'Infinity' : '-Infinity' } if x.infinite?
    { 'n' => x }
  when Symbol then x.to_s
  when String
    if x.encoding == Encoding::UTF_8 || x.encoding == Encoding::US_ASCII
      text(x) || { 'b' => x.unpack1('H*') }
    elsif x.encoding == Encoding::BINARY
      t = text(x)
      t && t !~ /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ ? t : { 'b' => x.unpack1('H*') }
    else
      { 'b' => x.b.unpack1('H*') }
    end
  when Array then x.map { |e| cj(e) }
  when Hash then { 'map' => x.map { |k, v| [cj(k), cj(v)] } }
  when Time then { 'ms' => (x.to_r * 1000).floor }
  when Regexp then { 'tag' => 'Regexp', 'v' => '/' + x.source + '/' + (x.options & 1 != 0 ? 'i' : '') + (x.options & 2 != 0 ? 'x' : '') + (x.options & 4 != 0 ? 'm' : '') }
  when Struct then { 'obj' => x.class.name, 'fields' => x.each_pair.map { |k, v| [k.to_s, cj(v)] } }
  when Range then { 'obj' => 'Range', 'fields' => [['excl', x.exclude_end?], ['begin', cj(x.begin)], ['end', cj(x.end)]] }
  when Class then { 'tag' => 'Class', 'v' => x.name }
  when Module then { 'tag' => 'Module', 'v' => x.name }
  else
    if x.respond_to?(:marshal_dump)
      { 'obj' => x.class.name, 'fields' => [['marshal_dump', cj(x.marshal_dump)]] }
    elsif x.respond_to?(:_dump)
      { 'obj' => x.class.name, 'fields' => [['_dump', cj(x._dump(-1))]] }
    else
      { 'obj' => x.class.name, 'fields' => x.instance_variables.map { |n| [n.to_s, cj(x.instance_variable_get(n))] } }
    end
  end
end

def write(name, data, expected, source)
  File.binwrite(File.join(OUT, name + '.bin'), data)
  File.write(File.join(OUT, name + '.json'), JSON.pretty_generate({ 'source' => source, 'layers' => [], 'format' => 'marshal', 'value' => expected }, allow_nan: false))
  puts "#{name} #{data.bytesize}"
end

class Visit
  def initialize(path, at) @path = path; @at = at; @count = 1 end
end
class Money
  def initialize(cents) @cents = cents end
  def marshal_dump() [@cents, 'EUR'] end
  def marshal_load(a) @cents = a[0] end
end
class Point
  def initialize(x, y) @x = x; @y = y end
  def _dump(_level) "#{@x},#{@y}" end
  def self._load(s) new(*s.split(',').map(&:to_i)) end
end
Pair = Struct.new(:left, :right)

shared = 'shared string'
value = {
  'name' => "café \u{1F525}", :symbol_key => :symbol_value, 'ascii' => 'plain'.encode('US-ASCII'),
  'binary' => "\x00\xFF".b, 'sjis' => 'テスト'.encode('Shift_JIS'), 'empty' => '',
  'ints' => [0, 1, -1, 122, 123, 255, 256, -123, -124, -256, -257, 65535, 65536, 2**30 - 1, 2**30, 2**31, 2**62, 2**64 + 5, -(2**70)],
  'floats' => [1.5, -0.25, 0.0, 1e100, Float::INFINITY, -Float::INFINITY, Float::NAN],
  'flags' => [true, false, nil],
  'nested' => { 'a' => [1, [2, [3, { 'b' => {} }]]] },
  'with_default' => Hash.new(0).merge('x' => 1),
  'time_utc' => Time.utc(2026, 10, 5, 12, 0, 0, 250000),
  'time_local' => Time.new(2026, 10, 5, 15, 0, 0, '+03:00'),
  'regexp' => /^a.*z$/i,
  'visit' => Visit.new('/cart', 1791218550),
  'money' => Money.new(1999),
  'point' => Point.new(3, 4),
  'pair' => Pair.new(1, 'two'),
  'range' => (1...10),
  'class' => String, 'module' => Comparable,
  'same' => [shared, shared, shared],
}
write('ruby-marshal', Marshal.dump(value), cj(value), "#{RUBY}, Marshal.dump")
write('ruby-marshal-string', Marshal.dump('just text'), cj('just text'), "#{RUBY}, Marshal.dump")
write('ruby-marshal-array', Marshal.dump([1, :a, 'b']), cj([1, :a, 'b']), "#{RUBY}, Marshal.dump")
