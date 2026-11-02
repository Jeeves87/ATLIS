// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

package atlis.bridge;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.game.Game;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.GameView;
import forge.game.card.Card;
import forge.game.phase.PhaseType;
import forge.game.player.PlayerView;
import forge.game.player.RegisteredPlayer;
import forge.gamemodes.match.HostedMatch;
import forge.gui.GuiBase;
import forge.gui.interfaces.IGuiGame;
import forge.interfaces.IGameController;
import forge.localinstance.properties.ForgePreferences;
import forge.model.FModel;
import forge.player.GamePlayerUtil;

/**
 * ATLIS ⇄ Forge bridge. Run with Forge's install folder as the working
 * directory and the Forge desktop jar on the classpath.
 *
 * Lifecycle: boot Forge (loads ~30k card scripts, 20–40s) → "ready" →
 * {"cmd":"start", ...} → "state"/"request" stream while ATLIS sends commands
 * → "gameOver". One match per process; ATLIS spawns a fresh bridge per game,
 * which keeps any engine state from leaking between games.
 */
public final class Main {
    private static volatile HostedMatch match;
    // Created after FModel.initialize: it touches PhaseType, whose labels need Forge's localizer loaded.
    private static BridgeGui GUI;
    private static HeadlessGui platform;

    public static Game game() {
        HostedMatch m = match;
        return m == null ? null : m.getGame();
    }

    public static void main(String[] args) throws Exception {
        // stdout is the protocol channel; everything Forge prints goes to stderr.
        PrintStream realOut = System.out;
        Protocol.init(realOut);
        System.setOut(new PrintStream(System.err, true, StandardCharsets.UTF_8));

        String version = args.length > 0 ? args[0] : "2.0.15";
        platform = new HeadlessGui(version);
        GuiBase.setInterface(platform);

        long t0 = System.currentTimeMillis();
        FModel.initialize(null, null);
        // Have Forge mark what the player can act on right now (castable spells,
        // usable abilities) — the source of ATLIS's "playable" glow. In memory
        // only: the user's saved Forge preferences are never written.
        FModel.getPreferences().setPref(ForgePreferences.FPref.UI_SHOW_ACTIONABLE_HIGHLIGHTS, true);
        // Choices from hidden zones (searching your library, picking from a
        // graveyard) come as "choose from these cards" questions instead of
        // clicks inside an opened zone panel, which the ATLIS table doesn't draw.
        FModel.getPreferences().setPref(ForgePreferences.FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);
        GUI = new BridgeGui();
        JsonObject ready = new JsonObject();
        ready.addProperty("forgeVersion", version);
        ready.addProperty("bootMs", System.currentTimeMillis() - t0);
        Protocol.event("ready", ready);

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) continue;
            JsonObject msg;
            try {
                msg = JsonParser.parseString(line).getAsJsonObject();
            } catch (RuntimeException e) {
                Protocol.error("bad json from host", e);
                continue;
            }
            String cmd = msg.has("cmd") ? msg.get("cmd").getAsString() : "";
            // Answers unblock an engine thread directly; everything else is a
            // UI action and runs on the GUI thread like a desktop click would.
            if ("answer".equals(cmd)) {
                Protocol.answer(msg.get("rid").getAsInt(), msg.get("value"));
            } else if ("quit".equals(cmd)) {
                break;
            } else {
                final JsonObject m = msg;
                platform.invokeInEdtLater(() -> dispatch(cmd, m));
            }
        }
        Protocol.cancelAll();
        System.exit(0);
    }

    private static void dispatch(String cmd, JsonObject m) {
        try {
            switch (cmd) {
                case "start" -> start(m);
                case "snapshot" -> GUI.flush();
                case "stops" -> stops(m);
                case "applyState" -> applyState(m);
                default -> act(cmd, m);
            }
        } catch (RuntimeException e) {
            Protocol.error("command " + cmd + " failed", e);
        }
    }

    /**
     * {"cmd":"start","players":[{"deck":"C:\\...\\x.dck","name":"You","ai":false}, {"deck":..., "ai":true}]}
     * At most one human seat; everyone else is Forge's AI.
     */
    private static void start(JsonObject m) {
        if (match != null) { Protocol.error("a match is already running", null); return; }
        List<RegisteredPlayer> players = new ArrayList<>();
        RegisteredPlayer human = null;
        for (JsonElement e : m.getAsJsonArray("players")) {
            JsonObject p = e.getAsJsonObject();
            File f = new File(p.get("deck").getAsString());
            Deck deck = DeckSerializer.fromFile(f);
            if (deck == null) { Protocol.error("could not read deck " + f, null); return; }
            boolean ai = p.has("ai") && p.get("ai").getAsBoolean();
            String name = p.has("name") ? p.get("name").getAsString() : deck.getName();
            RegisteredPlayer rp = RegisteredPlayer.forCommander(deck);
            rp.setPlayer(ai ? GamePlayerUtil.createAiPlayer(name) : GamePlayerUtil.getGuiPlayer(name, 0, 0, false));
            if (!ai) {
                if (human != null) { Protocol.error("only one human seat is supported", null); return; }
                human = rp;
            }
            players.add(rp);
        }
        GameRules rules = new GameRules(GameType.Commander);
        rules.setAppliedVariants(EnumSet.of(GameType.Commander));
        rules.setGamesPerMatch(1);

        HostedMatch hm = GuiBase.getInterface().hostMatch();
        match = hm;
        Map<RegisteredPlayer, IGuiGame> guis = new HashMap<>();
        if (human != null) guis.put(human, GUI);
        hm.setEndGameHook(GUI::finishGame);
        hm.startMatch(rules, EnumSet.of(GameType.Commander), players, guis, null);
        // AI-only games have no human GUI; watch as a spectator instead.
        if (human == null) hm.registerSpectator(GUI);
        // Forge only computes "what can I act on" highlights when the seat's
        // own controller asks for them; these settings live per controller.
        IGameController gc = GUI.getGameController();
        if (gc != null) {
            gc.setYieldPref(ForgePreferences.FPref.UI_SHOW_ACTIONABLE_HIGHLIGHTS, "true");
            gc.setYieldPref(ForgePreferences.FPref.UI_SHOW_AUTOTAP_PREVIEW, "true");
        }
        Protocol.event("started", null);
    }

    /**
     * TEST ONLY: replace the board with a Forge puzzle-format state
     * ({"cmd":"applyState","lines":["humanbattlefield=Inniaz, the Gale Force; Plains", ...]}),
     * exactly as Forge's own dev-mode "Setup Game State" does. Lets scenario
     * tests put the player's real cards in a real position and then play them
     * through the same clicks the table sends.
     */
    private static void applyState(JsonObject m) {
        Game game = game();
        if (game == null || game.getPhaseHandler().getPriorityPlayer() == null) {
            Protocol.error("applyState needs a game where someone has priority", null);
            return;
        }
        List<String> lines = new ArrayList<>();
        for (JsonElement e : m.getAsJsonArray("lines")) lines.add(e.getAsString());
        forge.game.GameState state = new forge.game.GameState();
        try {
            state.parse(lines);
        } catch (Exception e) {
            Protocol.error("bad state", e);
            return;
        }
        state.applyToGame(game);
        GUI.flush();
        Protocol.event("stateApplied", null);
    }

    private static void stops(JsonObject m) {
        GUI.setStops(phases(m.getAsJsonArray("own")), phases(m.getAsJsonArray("others")));
    }

    private static Set<PhaseType> phases(JsonArray a) {
        Set<PhaseType> s = EnumSet.noneOf(PhaseType.class);
        if (a != null) for (JsonElement e : a) s.add(PhaseType.valueOf(e.getAsString()));
        return s;
    }

    /** Player actions, mapped one-to-one onto Forge's controller interface. */
    private static void act(String cmd, JsonObject m) {
        IGameController c = GUI.getGameController();
        Game game = game();
        if (c == null || game == null) { Protocol.error("no game in progress for " + cmd, null); return; }
        switch (cmd) {
            case "ok" -> c.selectButtonOk();
            case "cancel" -> c.selectButtonCancel();
            case "card" -> {
                Card card = game.findById(m.get("id").getAsInt());
                if (card == null) { Protocol.event("invalid", null); return; }
                if (!c.selectCard(card.getView(), null, CLICK)) Protocol.event("invalid", null);
            }
            case "player" -> {
                PlayerView pv = playerView(m.get("id").getAsInt());
                if (pv != null) c.selectPlayer(pv, CLICK);
            }
            case "mana" -> c.useMana((byte) m.get("color").getAsInt());
            case "undo" -> c.undoLastAction();
            case "alphaStrike" -> c.alphaStrike();
            case "concede" -> c.concede();
            default -> Protocol.error("unknown command " + cmd, null);
        }
    }

    /**
     * A left click, as the desktop client reports it. Forge tells "the player
     * clicked this" (only playable abilities, a menu when there are several)
     * apart from "the engine is asking" (null event) by this argument.
     */
    private static final forge.util.ITriggerEvent CLICK = new forge.util.ITriggerEvent() {
        @Override public int getButton() { return 1; }
        @Override public int getX() { return 0; }
        @Override public int getY() { return 0; }
    };

    private static PlayerView playerView(int id) {
        GameView gv = GUI.getGameView();
        if (gv == null) return null;
        for (PlayerView p : gv.getPlayers()) if (p.getId() == id) return p;
        return null;
    }
}
