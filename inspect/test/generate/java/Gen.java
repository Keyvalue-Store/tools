// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Writes test values with Java's own ObjectOutputStream, with what each
// should decode to, the way test/generate/python.py does for Python.
//
//   javac -d /tmp/gen inspect/test/generate/java/Gen.java
//   java -cp /tmp/gen com.example.Gen inspect/test/fixtures

package com.example;

import java.io.*;
import java.lang.reflect.*;
import java.math.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;

class Person implements Serializable {
    private static final long serialVersionUID = 1L;
    protected String name;
    protected int age;
    Person(String name, int age) { this.name = name; this.age = age; }
}

class Customer extends Person {
    private static final long serialVersionUID = 2L;
    private final long id;
    private double balance;
    private boolean active = true;
    private char grade = 'A';
    private byte level = -3;
    private short rank = 300;
    private float score = 0.5f;
    private List<String> tags = new ArrayList<>(List.of("vip", "early"));
    private Map<String, Object> prefs = new LinkedHashMap<>();
    private Status status = Status.ACTIVE;
    private Customer referrer;
    private transient String password = "not written";
    Customer(String name, int age, long id, double balance) { super(name, age); this.id = id; this.balance = balance; prefs.put("lang", "pt"); prefs.put("emails", Boolean.FALSE); }
    void refer(Customer c) { referrer = c; }
}

enum Status { ACTIVE, SUSPENDED }

// Writes extra data of its own after its fields.
class Tracked implements Serializable {
    private static final long serialVersionUID = 3L;
    String label = "tracked";
    private void writeObject(ObjectOutputStream out) throws IOException {
        out.defaultWriteObject();
        out.writeInt(7);
        out.writeObject("extra");
    }
}

// Writes everything itself.
class Token implements Externalizable {
    private static final long serialVersionUID = 4L;
    public Token() {}
    public void writeExternal(ObjectOutput out) throws IOException { out.writeUTF("x"); out.writeInt(5); out.writeObject("y"); }
    public void readExternal(ObjectInput in) throws IOException, ClassNotFoundException {}
}

public class Gen {
    static final Set<String> MAPS = Set.of("java.util.HashMap", "java.util.LinkedHashMap", "java.util.Hashtable", "java.util.TreeMap", "java.util.Properties");
    static final Set<String> LISTS = Set.of("java.util.ArrayList", "java.util.LinkedList", "java.util.ArrayDeque", "java.util.Vector", "java.util.Stack", "java.util.HashSet", "java.util.LinkedHashSet", "java.util.TreeSet");

    // JSON by hand, so the generator needs nothing beyond the JDK.
    static String json(Object x) {
        if (x == null) return "null";
        if (x instanceof Boolean) return x.toString();
        if (x instanceof Double d) return d.isNaN() ? "\"NaN\"" : d.isInfinite() ? (d > 0 ? "\"Infinity\"" : "\"-Infinity\"") : (d == Math.rint(d) && Math.abs(d) < 1e15 ? String.valueOf(d.longValue()) : d.toString());
        if (x instanceof String s) {
            StringBuilder b = new StringBuilder("\"");
            for (char c : s.toCharArray()) {
                if (c == '"' || c == '\\') b.append('\\').append(c);
                else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                else b.append(c);
            }
            return b.append('"').toString();
        }
        if (x instanceof Map<?, ?> m) {
            StringJoiner j = new StringJoiner(", ", "{", "}");
            for (Map.Entry<?, ?> e : m.entrySet()) j.add(json(e.getKey().toString()) + ": " + json(e.getValue()));
            return j.toString();
        }
        if (x instanceof List<?> l) {
            StringJoiner j = new StringJoiner(", ", "[", "]");
            for (Object e : l) j.add(json(e));
            return j.toString();
        }
        throw new IllegalArgumentException(x.getClass().getName());
    }
    static Map<String, Object> m(Object... kv) { Map<String, Object> o = new LinkedHashMap<>(); for (int i = 0; i < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]); return o; }
    static String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x & 0xff)); return s.toString(); }

    // What the inspector should find.
    static Object cj(Object x) throws Exception {
        if (x == null) return null;
        if (x instanceof String) return x;
        if (x instanceof Integer || x instanceof Long || x instanceof Short || x instanceof Byte || x instanceof BigInteger) return m("i", x.toString());
        if (x instanceof Double d) return m("n", d);
        if (x instanceof Float f) return m("n", (double) f);
        if (x instanceof Boolean) return x;
        if (x instanceof Character c) return String.valueOf(c);
        if (x instanceof BigDecimal bd) return m("dec", bd.toPlainString());
        if (x instanceof Date d) return m("ms", (double) d.getTime());
        if (x instanceof UUID u) return m("tag", "UUID", "v", u.toString());
        if (x instanceof Instant i) return m("ms", (double) i.toEpochMilli());
        if (x instanceof ZoneOffset z) return m("tag", "java.time.ZoneOffset", "v", z.toString());
        if (x instanceof ZoneId z) return m("tag", "java.time.ZoneId", "v", z.toString());
        if (x.getClass().getName().startsWith("java.time.")) return m("tag", "java.time." + x.getClass().getSimpleName(), "v", x.toString());
        if (x instanceof Enum<?> e) return m("obj", e.getDeclaringClass().getName() + "." + e.name(), "fields", List.of());
        String cls = x.getClass().getName();
        if (MAPS.contains(cls)) { List<Object> pairs = new ArrayList<>(); for (Map.Entry<?, ?> e : ((Map<?, ?>) x).entrySet()) pairs.add(Arrays.asList(cj(e.getKey()), cj(e.getValue()))); return m("map", pairs); }
        if (LISTS.contains(cls)) { List<Object> out = new ArrayList<>(); for (Object e : (Collection<?>) x) out.add(cj(e)); return out; }
        if (x instanceof byte[] b) return m("b", hex(b));
        if (x.getClass().isArray()) { List<Object> out = new ArrayList<>(); for (int i = 0; i < Array.getLength(x); i++) out.add(cj(Array.get(x, i))); return out; }
        if (x instanceof Token) return m("obj", cls, "fields", List.of(Arrays.asList("written by writeExternal", List.of(m("b", "00017800000005"), "y"))));
        // Serializable classes: each class's fields, topmost superclass first,
        // in the order ObjectStreamClass gives them.
        List<Class<?>> chain = new ArrayList<>();
        for (Class<?> c = x.getClass(); c != null && Serializable.class.isAssignableFrom(c); c = c.getSuperclass()) chain.add(0, c);
        List<Object> fields = new ArrayList<>();
        for (Class<?> c : chain) {
            for (ObjectStreamField f : ObjectStreamClass.lookup(c).getFields()) {
                Field r = c.getDeclaredField(f.getName());
                r.setAccessible(true);
                fields.add(Arrays.asList(f.getName(), cj(r.get(x))));
            }
        }
        if (x instanceof Tracked) fields.add(Arrays.asList("written by writeObject", List.of(m("b", "00000007"), "extra")));
        return m("obj", cls, "fields", fields);
    }

    static Path out;
    static void write(String name, Object value, Object expected) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ObjectOutputStream o = new ObjectOutputStream(bytes)) { o.writeObject(value); }
        save(name, bytes.toByteArray(), expected);
    }
    static void save(String name, byte[] data, Object expected) throws Exception {
        Files.write(out.resolve(name + ".bin"), data);
        String src = "Java " + System.getProperty("java.version") + ", ObjectOutputStream";
        Files.writeString(out.resolve(name + ".json"), json(m("source", src, "layers", List.of(), "format", "java", "value", expected)) + "\n");
        System.out.println(name + " " + data.length);
    }

    public static void main(String[] args) throws Exception {
        out = Paths.get(args[0]);
        Customer alice = new Customer("Alice", 34, 9007199254740993L, 1234.56);
        Customer bob = new Customer("Bob", 41, 2L, -5);
        bob.refer(alice);

        Map<String, Object> session = new HashMap<>();
        session.put("user", alice);
        session.put("referred", bob);
        session.put("lastSeen", new Date(1791218550123L));
        session.put("visits", 42);
        session.put("cart", new ArrayList<>(List.of("sku-1", "sku-2")));
        session.put("token", UUID.fromString("12345678-1234-5678-1234-567812345678"));
        write("java-session", session, cj(session));

        Map<String, Object> values = new LinkedHashMap<>();
        values.put("int", Integer.MIN_VALUE);
        values.put("long", Long.MAX_VALUE);
        values.put("short", (short) -2);
        values.put("byte", (byte) 127);
        values.put("double", Math.PI);
        values.put("float", 1.25f);
        values.put("bool", true);
        values.put("char", 'é');
        values.put("text", "café 🔥 \u0000 nul");
        values.put("long text", "x".repeat(70000));
        values.put("bigint", new BigInteger("-123456789012345678901234567890"));
        values.put("decimal", new BigDecimal("12345.6789"));
        values.put("small decimal", new BigDecimal("0.00012"));
        values.put("ints", new int[] { 1, -2, 3 });
        values.put("strings", new String[] { "a", null, "c" });
        values.put("bytes", new byte[] { 0, 1, (byte) 0xff });
        values.put("matrix", new long[][] { { 1L }, { 2L, 3L } });
        values.put("linked", new LinkedList<>(List.of(1, 2)));
        values.put("set", new LinkedHashSet<>(List.of("x", "y")));
        values.put("tree", new TreeSet<>(List.of(3, 1, 2)));
        values.put("sorted", new TreeMap<>(Map.of("b", 2, "a", 1)));
        values.put("table", new Hashtable<>(Map.of("k", "v")));
        values.put("deque", new ArrayDeque<>(List.of('p', 'q')));
        values.put("status", Status.SUSPENDED);
        values.put("tracked", new Tracked());
        values.put("token", new Token());
        values.put("timestamp", new java.sql.Timestamp(1791218550456L));
        java.sql.Timestamp nanos = new java.sql.Timestamp(1791218550000L);
        nanos.setNanos(456789012);
        values.put("timestamp nanos", nanos);
        values.put("vector", new Vector<>(List.of("a", 1, "b")));
        Stack<String> stack = new Stack<>();
        stack.push("x");
        stack.push("y");
        values.put("stack", stack);
        values.put("old date", LocalDate.of(-5, 1, 1));
        values.put("instant", Instant.ofEpochSecond(1791218550L, 123456789));
        values.put("date", LocalDate.of(2026, 10, 5));
        values.put("time", LocalTime.of(9, 30));
        values.put("time2", LocalTime.of(9, 30, 15, 250000000));
        values.put("datetime", LocalDateTime.of(2026, 10, 5, 12, 0, 1, 1000));
        values.put("zoned", ZonedDateTime.of(2026, 10, 5, 12, 0, 0, 0, ZoneId.of("Europe/Lisbon")));
        values.put("offset", OffsetDateTime.of(2026, 10, 5, 12, 0, 0, 0, ZoneOffset.ofHoursMinutes(5, 30)));
        values.put("duration", Duration.ofSeconds(29172, 345000000));
        values.put("negative duration", Duration.ofMillis(-1500));
        values.put("period", Period.of(1, 2, 3));
        values.put("zone", ZoneId.of("America/New_York"));
        values.put("zone offset", ZoneOffset.ofHours(-3));
        values.put("year month", YearMonth.of(2026, 10));
        values.put("same", Arrays.asList(alice, alice).toArray());
        write("java-values", values, cj(values));

        write("java-string", "just text", "just text");
        write("java-integer", 42, cj(42));

        // Two objects and an int in one stream.
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ObjectOutputStream o = new ObjectOutputStream(bytes)) { o.writeObject("first"); o.writeInt(5); o.writeObject(List.of(1, 2).toArray()); }
        save("java-stream", bytes.toByteArray(), List.of("first", m("b", "00000005"), List.of(m("i", "1"), m("i", "2"))));
    }
}
