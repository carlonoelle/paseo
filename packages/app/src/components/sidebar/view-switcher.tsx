import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bookmark, ChevronDown } from "lucide-react-native";
import {
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
  type MenuTriggerState,
} from "@/components/ui/menu";
import { isWeb } from "@/constants/platform";
import { useSidebarViewStore, type SidebarSavedView } from "@/stores/sidebar-view-store";
import {
  MENU_WIDTH,
  mutedIconMapping,
  OPTION_ICON_SIZE,
} from "@/components/sidebar/display-preferences/menu-metrics";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedBookmark = withUnistyles(Bookmark);

const VIEW_LEADING = <ThemedBookmark size={OPTION_ICON_SIZE} uniProps={mutedIconMapping} />;

/**
 * The workspace section's title, made into a picker once there is a saved view to pick.
 *
 * It names what the list below is showing, so switching views happens where you read which one
 * you are in. Saving, renaming, and deleting views stay in the display menu.
 */
export function SidebarViewSwitcher({ title }: { title: string }): ReactElement {
  const { t } = useTranslation();
  const savedViews = useSidebarViewStore((state) => state.savedViews);
  const activeViewId = useSidebarViewStore((state) => state.activeViewId);
  const selectView = useSidebarViewStore((state) => state.selectView);
  const hasFilters = useSidebarViewStore(
    (state) =>
      state.hostFilters.length > 0 ||
      state.projectFilters.length > 0 ||
      state.labelFilter.labels.length > 0,
  );
  const activeView = savedViews.find((view) => view.id === activeViewId) ?? null;
  // An ad-hoc filter is not "all workspaces", so the row is only checked when nothing narrows the
  // list, and picking it clears the ad-hoc filter as its label says.
  const showsAll = activeViewId === null && !hasFilters;
  const selectAll = useCallback(() => selectView(null), [selectView]);

  const triggerStyle = useCallback(
    ({ hovered, open }: MenuTriggerState) => [
      styles.trigger,
      (hovered || open) && styles.triggerHovered,
    ],
    [],
  );

  return (
    <MenuRoot compactMode="sheet">
      <MenuTrigger
        style={triggerStyle}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.display.view.label")}
        testID="sidebar-view-switcher"
      >
        <Text style={styles.label} numberOfLines={1}>
          {activeView?.name ?? title}
        </Text>
        <ThemedChevronDown size={12} uniProps={mutedIconMapping} />
      </MenuTrigger>
      <MenuSurface
        align="start"
        width={MENU_WIDTH}
        sheetTitle={t("sidebar.display.view.heading")}
        testID="sidebar-view-switcher-content"
      >
        <MenuItem selected={showsAll} onSelect={selectAll} testID="sidebar-view-switcher-all">
          {t("sidebar.display.view.all")}
        </MenuItem>
        <MenuSeparator />
        {savedViews.map((view) => (
          <SidebarViewOption
            key={view.id}
            view={view}
            selected={view.id === activeViewId}
            onSelect={selectView}
          />
        ))}
      </MenuSurface>
    </MenuRoot>
  );
}

export function SidebarViewOption({
  view,
  selected,
  closeOnSelect = true,
  leaveOnReselect = false,
  onSelect,
}: {
  view: SidebarSavedView;
  selected: boolean;
  closeOnSelect?: boolean;
  /** Picking the checked view leaves it, for lists with no "All workspaces" row of their own. */
  leaveOnReselect?: boolean;
  onSelect: (id: string | null) => void;
}): ReactElement {
  const handleSelect = useCallback(
    () => onSelect(leaveOnReselect && selected ? null : view.id),
    [leaveOnReselect, onSelect, selected, view.id],
  );
  return (
    <MenuItem
      selected={selected}
      leading={VIEW_LEADING}
      closeOnSelect={closeOnSelect}
      onSelect={handleSelect}
      testID={`sidebar-view-option-${view.id}`}
    >
      {view.name}
    </MenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The fill reaches past the text on both sides; the negative margin keeps the text itself on
  // the section title's rail.
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    flexShrink: 1,
    height: 24,
    marginLeft: -theme.spacing[1.5],
    paddingHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
