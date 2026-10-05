<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Writes test values with PHP's own serialize(), session_encode() and the
// igbinary extension, with what each should decode to, the way
// test/generate/python.py does for Python.
//
//   php inspect/test/generate/php.php

session_save_path(sys_get_temp_dir());
@session_start();

$OUT = __DIR__ . '/../fixtures';
$PHP = 'PHP ' . PHP_VERSION;

function cj($x) {
    if ($x === null) return null;
    if (is_bool($x)) return $x;
    if (is_int($x)) return ['i' => (string)$x];
    if (is_float($x)) {
        if (is_nan($x)) return ['n' => 'NaN'];
        if (is_infinite($x)) return ['n' => $x > 0 ? 'Infinity' : '-Infinity'];
        return ['n' => $x];
    }
    if (is_string($x)) return mb_check_encoding($x, 'UTF-8') ? $x : ['b' => bin2hex($x)];
    if (is_array($x)) {
        if (array_is_list($x)) return array_map('cj', $x);
        $pairs = [];
        foreach ($x as $k => $v) $pairs[] = [cj($k), cj($v)];
        return ['map' => $pairs];
    }
    if ($x instanceof UnitEnum) return ['obj' => get_class($x), 'fields' => []];
    $fields = [];
    foreach ((array)$x as $k => $v) {
        $name = $k[0] === "\0" ? substr($k, strrpos($k, "\0") + 1) : $k;
        $fields[] = [$name, cj($v)];
    }
    return ['obj' => get_class($x), 'fields' => $fields];
}

function write($name, $data, $expected, $format, $source) {
    global $OUT;
    file_put_contents("$OUT/$name.bin", $data);
    file_put_contents("$OUT/$name.json", json_encode(['source' => $source, 'layers' => [], 'format' => $format, 'value' => $expected],
        JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_PARTIAL_OUTPUT_ON_ERROR));
    echo $name, ' ', strlen($data), "\n";
}

class Account {
    public $name = 'alice';
    protected $balance = 12.5;
    private $secret = "s\0cret";
    public $tags = ['a', 'b'];
    public $owner = null;
}
class Session2 { public $user; public $at; public function __construct($u, $t) { $this->user = $u; $this->at = $t; } }
enum Suit: string { case Hearts = 'H'; case Spades = 'S'; }

$value = [
    'name' => 'caf' . "\u{e9}" . ' ' . "\u{1F525}",
    'count' => 42, 'big' => PHP_INT_MAX, 'small' => PHP_INT_MIN, 'neg' => -300,
    'ratio' => 0.1, 'whole' => 2.0, 'tiny' => 1.5e-300, 'inf' => INF, 'ninf' => -INF, 'nan' => NAN,
    'yes' => true, 'no' => false, 'none' => null,
    'list' => [1, 'two', 3.5, [4]], 'map' => ['b' => 1, 'a' => 2, 7 => 'seven', '-1' => 'minus'],
    'empty' => [], 'emptystr' => '', 'binary' => "\x00\xff\x01",
    'account' => new Account(), 'std' => (object)['k' => 'v', 'n' => [1, 2]],
    'suit' => Suit::Hearts,
    'nested' => ['a' => ['b' => ['c' => ['d' => 'deep']]]],
];
write('php-serialize', serialize($value), cj($value), 'php', "$PHP, serialize()");
write('php-serialize-string', serialize("just text"), cj("just text"), 'php', "$PHP, serialize()");
write('php-serialize-int', serialize(-12), cj(-12), 'php', "$PHP, serialize()");

// References: the same object twice, and a PHP reference.
$o = new stdClass();
$o->id = 1;
$shared = [$o, $o];
$x = 5;
$refs = ['obj' => $shared, 'a' => &$x, 'b' => &$x];
write('php-serialize-refs', serialize($refs), cj($refs), 'php', "$PHP, serialize() with references");

// A session, as the default "php" session handler stores it.
$_SESSION = ['user_id' => 42, 'cart' => ['sku-1' => 2], 'flash' => 'Saved.', 'login' => new Session2('alice', 1791218550)];
write('php-session', session_encode(), ['map' => array_map(fn($k) => [$k, cj($_SESSION[$k])], array_keys($_SESSION))], 'php-session', "$PHP, session_encode() with session.serialize_handler=php");

// igbinary, which phpredis and Memcached can use instead of serialize().
unset($value['nan']);
$value['long_string'] = str_repeat('x', 300);
$value['strings'] = ['same', 'same', 'other', 'same'];
$value['accounts'] = [new Account(), new Account()];
$value['ints'] = [0, 255, 256, 65535, 65536, 4294967295, 4294967296, -1, -255, -256, -65535, -65536, -4294967295, -4294967296];
write('php-igbinary', igbinary_serialize($value), cj($value), 'igbinary', "$PHP, igbinary " . phpversion('igbinary'));
$ig = [$o, $o];
write('php-igbinary-refs', igbinary_serialize($ig), cj($ig), 'igbinary', "$PHP, igbinary with the same object twice");
$y = [1];
$z = ['a' => &$y, 'b' => &$y, 'c' => 7];
$z['d'] = &$z['c'];
write('php-igbinary-phprefs', igbinary_serialize($z), cj($z), 'igbinary', "$PHP, igbinary with PHP references");
write('php-serialize-phprefs', serialize($z), cj($z), 'php', "$PHP, serialize() with PHP references");
