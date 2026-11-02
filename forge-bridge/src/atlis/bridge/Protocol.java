// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

package atlis.bridge;

import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * The wire: one JSON object per line on stdout, ATLIS's replies one per line
 * on stdin. stdout is reserved for protocol lines — Forge's own console
 * chatter is redirected to stderr in Main so it can't corrupt the stream.
 *
 * A "request" is the engine asking the player something (pick targets, order
 * triggers, confirm). The asking thread blocks until the matching "answer"
 * arrives, exactly like a modal dialog does in Forge's desktop client.
 */
public final class Protocol {
    private static final Gson GSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();
    private static PrintStream out;
    private static final AtomicInteger NEXT_ID = new AtomicInteger(1);
    private static final Map<Integer, CompletableFuture<JsonElement>> PENDING = new ConcurrentHashMap<>();

    private Protocol() { }

    static void init(PrintStream realStdout) {
        out = new PrintStream(realStdout, true, StandardCharsets.UTF_8);
    }

    public static Gson gson() { return GSON; }

    public static synchronized void send(JsonObject msg) {
        out.println(GSON.toJson(msg));
        out.flush();
    }

    public static void event(String type, JsonObject body) {
        JsonObject m = body == null ? new JsonObject() : body;
        m.addProperty("type", type);
        send(m);
    }

    /** Ask ATLIS a question and wait for the answer. Null if the game is being torn down. */
    public static JsonElement request(String kind, JsonObject body) {
        int id = NEXT_ID.getAndIncrement();
        CompletableFuture<JsonElement> f = new CompletableFuture<>();
        PENDING.put(id, f);
        body.addProperty("type", "request");
        body.addProperty("kind", kind);
        body.addProperty("rid", id);
        send(body);
        try {
            return f.get();
        } catch (Exception e) {
            return null;
        } finally {
            PENDING.remove(id);
        }
    }

    static void answer(int rid, JsonElement value) {
        CompletableFuture<JsonElement> f = PENDING.get(rid);
        if (f != null) f.complete(value);
    }

    /** Release every waiting request (game over / quit), so engine threads can unwind. */
    static void cancelAll() {
        for (CompletableFuture<JsonElement> f : PENDING.values()) f.complete(null);
    }

    public static void error(String message, Throwable t) {
        JsonObject m = new JsonObject();
        m.addProperty("message", message + (t == null ? "" : ": " + t));
        event("error", m);
        if (t != null) t.printStackTrace(System.err);
    }
}
