import { createMemo, createResource, For, Show } from "solid-js";
import { FEATURE_BY_ID, FEATURES } from "../../features/manifest";
import {
	activeFeatureIds,
	featurePreferences,
	featureReloadPending,
	preferredFeatureIds,
	setFeaturePreference,
} from "../../features/preferences";
import {
	featureOwnSize,
	featureSizeTotals,
	formatKilobytes,
	loadFeatureSizes,
} from "../../features/sizes";
import { SettingsGroup } from "./SettingsGroup";
import { SettingToggle } from "./controls/SettingToggle";

/**
 * Settings > Features: per-browser feature toggles plus bundle sizes.
 * Toggles persist to localStorage and take effect on reload. Sizes come
 * from the build's feature-sizes.json; dev builds have none, so the panel
 * says so instead of showing numbers. `query` filters the feature rows for
 * settings search; without it the panel shows the bundle summary.
 */
export function FeaturesSettings(props: { query?: string }) {
	const [sizes] = createResource(loadFeatureSizes);
	const rows = createMemo(() => {
		const q = (props.query ?? "").trim().toLowerCase();
		if (q === "") return FEATURES;
		return FEATURES.filter((f) => `${f.label} ${f.description}`.toLowerCase().includes(q));
	});
	const loadedLabels = createMemo(() =>
		FEATURES.filter((f) => activeFeatureIds().has(f.id))
			.map((f) => f.label)
			.join(", "),
	);
	const pendingLabels = createMemo(() =>
		preferredFeatureIds()
			.map((id) => FEATURE_BY_ID[id].label)
			.join(", "),
	);
	const loadedTotals = createMemo(() => {
		const m = sizes();
		return m ? featureSizeTotals(m, activeFeatureIds()) : null;
	});
	const pendingTotals = createMemo(() => {
		const m = sizes();
		return m ? featureSizeTotals(m, preferredFeatureIds()) : null;
	});

	return (
		<div class="features-settings">
			<Show when={!props.query?.trim()}>
				<section class="features-summary" aria-label="Bundle size">
					<Show when={loadedTotals()}>
						{(t) => (
							<div class="features-summary-line">
								<span>Loaded: {loadedLabels() || "core only"}</span>
								<span class="feature-size">
									{formatKilobytes(t().gzip)} gzip · {formatKilobytes(t().bytes)} raw
								</span>
							</div>
						)}
					</Show>
					<Show when={featureReloadPending()}>
						<div class="features-reload">
							<span>
								After reload: {pendingLabels() || "core only"}
								<Show when={pendingTotals()}>
									{(t) => <> · {formatKilobytes(t().gzip)} gzip</>}
								</Show>
							</span>
							<button
								type="button"
								class="settings-control-btn"
								onClick={() => window.location.reload()}
							>
								Reload to apply
							</button>
						</div>
					</Show>
					<Show when={!sizes.loading && !sizes()}>
						<div>Sizes are measured in production builds.</div>
					</Show>
				</section>
			</Show>
			<Show when={rows().length > 0}>
				<SettingsGroup title="Features">
					<For each={rows()}>
						{(f) => (
							<div class="settings-item">
								<div class="settings-item-text">
									<div class="settings-item-label">
										<span>{f.label}</span>
										<Show when={f.experimental}>
											<span class="badge">Experimental</span>
										</Show>
									</div>
									<p class="settings-item-desc">{f.description}</p>
									<p class="feature-meta">
										{activeFeatureIds().has(f.id) ? "Loaded" : "Not loaded"}
										<Show when={sizes()}>
											{(m) => (
												<Show when={featureOwnSize(m(), f.id)}>
													{(s) => <> · {formatKilobytes(s().gzip)} gzip</>}
												</Show>
											)}
										</Show>
									</p>
								</div>
								<div class="settings-item-control">
									<SettingToggle
										label={`Enable ${f.label}`}
										checked={featurePreferences()[f.id]}
										onChange={(checked) => setFeaturePreference(f.id, checked)}
									/>
								</div>
							</div>
						)}
					</For>
				</SettingsGroup>
			</Show>
		</div>
	);
}
