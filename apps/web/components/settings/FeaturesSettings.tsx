import { createMemo, createResource, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { FEATURES } from "../../features/manifest";
import { activeFeatureIds, featurePreferences } from "../../features/preferences";
import { featureSettingsAction, setFeatureEnabled } from "../../features/registry";
import {
	featureOwnSize,
	featureSizeTotals,
	formatKilobytes,
	loadFeatureSizes,
} from "../../features/sizes";
import { SettingsGroup } from "./SettingsGroup";
import { SettingToggle } from "./controls/SettingToggle";

/** Feature rows matching a settings-search query; the whole list for an empty query. */
export function searchFeatures(query: string) {
	const q = query.trim().toLowerCase();
	if (q === "") return FEATURES;
	return FEATURES.filter((f) => `${f.label} ${f.description}`.toLowerCase().includes(q));
}

/**
 * Settings > Features: per-browser feature toggles plus bundle sizes.
 * A toggle loads or unloads its feature on this page at once; the attached
 * session, draft and sheet stay as they are. A feature marked "In development"
 * is listed with a disabled, unchecked toggle and cannot be turned on. Sizes come from the build's
 * feature-sizes.json; dev builds have none, so the panel says so instead of
 * showing numbers. `query` filters the feature rows for settings search;
 * without it the panel shows the bundle summary.
 */
export function FeaturesSettings(props: { query?: string }) {
	const [sizes] = createResource(loadFeatureSizes);
	const rows = createMemo(() => searchFeatures(props.query ?? ""));
	const loadedLabels = createMemo(() =>
		FEATURES.filter((f) => activeFeatureIds().has(f.id))
			.map((f) => f.label)
			.join(", "),
	);
	const loadedTotals = createMemo(() => {
		const m = sizes();
		return m ? featureSizeTotals(m, activeFeatureIds()) : null;
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
										<Show when={f.status === "in-development"}>
											<span class="badge">In development</span>
										</Show>
									</div>
									<p class="settings-item-desc">{f.description}</p>
									<Show when={featureSettingsAction(f.id)}>
										{(action) => (
											<p>
												<Dynamic component={action()} />
											</p>
										)}
									</Show>
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
										disabled={f.status === "in-development"}
										onChange={(checked) => void setFeatureEnabled(f.id, checked)}
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
