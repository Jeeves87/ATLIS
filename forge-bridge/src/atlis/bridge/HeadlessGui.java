// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

package atlis.bridge;

import java.io.File;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.Consumer;

import forge.gamemodes.match.HostedMatch;
import forge.gui.download.GuiDownloadService;
import forge.gui.interfaces.IGuiBase;
import forge.gui.interfaces.IGuiGame;
import forge.item.PaperCard;
import forge.localinstance.skin.FSkinProp;
import forge.localinstance.skin.ISkinImage;
import forge.sound.IAudioClip;
import forge.sound.IAudioMusic;
import forge.util.FSerializableFunction;
import forge.util.ImageFetcher;

/**
 * Forge's platform layer with no windows. Forge reaches its "GUI thread"
 * through these hooks; here that thread is a single executor, which also runs
 * every command ATLIS sends, so the engine sees UI actions arrive on the same
 * thread it expects in the desktop client.
 *
 * Images, sound and dialogs are stubs: ATLIS draws the table itself.
 */
public final class HeadlessGui implements IGuiBase {
    private final ExecutorService edt = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "atlis-edt");
        t.setDaemon(true);
        return t;
    });
    private volatile Thread edtThread;
    private final String version;

    public HeadlessGui(String version) {
        this.version = version;
        try {
            edt.submit(() -> edtThread = Thread.currentThread()).get();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ---- threading ----
    @Override public void invokeInEdtNow(Runnable r) { if (isGuiThread()) r.run(); else invokeInEdtAndWait(r); }
    @Override public void invokeInEdtLater(Runnable r) { edt.submit(guard(r)); }
    @Override public void invokeInEdtAndWait(Runnable r) {
        if (isGuiThread()) { r.run(); return; }
        Future<?> f = edt.submit(guard(r));
        try { f.get(); } catch (Exception e) { Protocol.error("edt task failed", e); }
    }
    @Override public void runBackgroundTask(String message, Runnable r) {
        Thread t = new Thread(guard(r), "atlis-bg");
        t.setDaemon(true);
        t.start();
    }
    @Override public boolean isGuiThread() { return Thread.currentThread() == edtThread; }

    private static Runnable guard(Runnable r) {
        return () -> {
            try { r.run(); } catch (Throwable t) { Protocol.error("task failed", t); }
        };
    }

    // ---- identity / assets ----
    @Override public boolean isRunningOnDesktop() { return true; }
    @Override public boolean isLibgdxPort() { return false; }
    @Override public String getCurrentVersion() { return version; }
    /** Forge resolves res/ relative to this; the bridge runs with Forge's install folder as cwd. */
    @Override public String getAssetsDir() { return ""; }
    @Override public ImageFetcher getImageFetcher() {
        return new ImageFetcher() {
            @Override protected Runnable getDownloadTask(String[] urls, String dest, Runnable notify) { return () -> { }; }
        };
    }

    // ---- images / skin (unused: ATLIS renders) ----
    @Override public ISkinImage getSkinIcon(FSkinProp p) { return null; }
    @Override public ISkinImage getUnskinnedIcon(String path) { return null; }
    @Override public ISkinImage getCardArt(PaperCard card, boolean backFace) { return null; }
    @Override public ISkinImage createLayeredImage(PaperCard card, FSkinProp background, String overlay, float opacity) { return null; }
    @Override public void clearImageCache() { }
    @Override public String encodeSymbols(String str, boolean formatReminderText) { return str; }
    @Override public int getAvatarCount() { return 0; }
    @Override public int getSleevesCount() { return 0; }
    @Override public float getScreenScale() { return 1f; }
    @Override public void preventSystemSleep(boolean b) { }

    // ---- downloads / OS ----
    @Override public void download(GuiDownloadService service, Consumer<Boolean> callback) { if (callback != null) callback.accept(false); }
    @Override public void copyToClipboard(String text) { }
    @Override public void browseToUrl(String url) { }

    // ---- dialogs outside a game (deck editors, shops): never shown headless ----
    @Override public void showCardList(String title, String message, List<PaperCard> list) { }
    @Override public boolean showBoxedProduct(String title, String message, List<PaperCard> list) { return false; }
    @Override public void showBugReportDialog(String title, String text, boolean showExitAppBtn) { Protocol.error("forge bug report: " + title + "\n" + text, null); }
    @Override public void showImageDialog(ISkinImage image, String message, String title) { }
    @Override public int showOptionDialog(String message, String title, FSkinProp icon, List<String> options, int defaultOption) { return defaultOption; }
    @Override public String showInputDialog(String message, String title, FSkinProp icon, String initialInput, List<String> inputOptions, boolean isNumeric) { return initialInput; }
    @Override public String showFileDialog(String title, String defaultDir) { return null; }
    @Override public File getSaveFile(File defaultFile) { return defaultFile; }
    @Override public <T> List<T> order(String title, String top, int remainingObjectsMin, int remainingObjectsMax, List<T> sourceChoices, List<T> destChoices) {
        List<T> out = new ArrayList<>(sourceChoices);
        if (destChoices != null) out.addAll(destChoices);
        return out;
    }
    @Override public <T> List<T> getChoices(String message, int min, int max, Collection<T> choices, Collection<T> selected, FSerializableFunction<T, String> display) {
        List<T> out = new ArrayList<>();
        for (T t : choices) { if (out.size() >= min) break; out.add(t); }
        return out;
    }
    @Override public PaperCard chooseCard(String title, String message, List<PaperCard> list) { return list.isEmpty() ? null : list.get(0); }

    // ---- sound ----
    @Override public boolean isSupportedAudioFormat(File file) { return false; }
    @Override public IAudioClip createAudioClip(String filename) { return null; }
    @Override public IAudioMusic createAudioMusic(String filename) { return null; }
    @Override public void startAltSoundSystem(String filename, boolean isSynchronized) { }

    // ---- modes we don't host ----
    @Override public void showSpellShop() { }
    @Override public void showBazaar() { }
    @Override public IGuiGame getNewGuiGame() { return new BridgeGui(); }
    @Override public HostedMatch hostMatch() { return new HostedMatch(); }
    @Override public org.jupnp.UpnpServiceConfiguration getUpnpPlatformService() { return null; }
    @Override public boolean hasNetGame() { return false; }
}
