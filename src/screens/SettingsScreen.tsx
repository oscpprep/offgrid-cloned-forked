import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Linking,
  Alert,
  Switch,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { AttachStep } from 'react-native-spotlight-tour';
import { useNavigation, CommonActions, CompositeNavigationProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { Card } from '../components';
import { AnimatedEntry } from '../components/AnimatedEntry';
import { AnimatedListItem } from '../components/AnimatedListItem';
import { MadeWithLove } from '../components/MadeWithLove';
import { useFocusTrigger } from '../hooks/useFocusTrigger';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors, ThemeShadows } from '../theme';
import { TYPOGRAPHY, SPACING } from '../constants';
import DeviceInfo from 'react-native-device-info';
import RNFS from 'react-native-fs';
import { useAppStore, useRemoteServerStore } from '../stores';
import { hardwareService, localApiServerService } from '../services';
import { RootStackParamList, MainTabParamList } from '../navigation/types';
import { GITHUB_URL, SHARE_ON_X_URL } from '../utils/sharePrompt';
import packageJson from '../../package.json';

const FEEDBACK_EMAIL = 'work@wednesday.is';
const DEFAULT_LOCAL_API_SETTINGS = {
  localApiServerEnabled: false,
  localApiServerPort: 3333,
  localApiServerApiKey: '',
};

type NavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'SettingsTab'>,
  NativeStackNavigationProp<RootStackParamList>
>;

export const SettingsScreen: React.FC = () => {
  const navigation = useNavigation<NavigationProp>();
  const focusTrigger = useFocusTrigger();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const setOnboardingComplete = useAppStore((s) => s.setOnboardingComplete);
  const themeMode = useAppStore((s) => s.themeMode);
  const setThemeMode = useAppStore((s) => s.setThemeMode);
  const completeChecklistStep = useAppStore((s) => s.completeChecklistStep);
  const resetChecklist = useAppStore((s) => s.resetChecklist);
  const deviceInfo = useAppStore((s) => s.deviceInfo);
  const settings = useAppStore((s) => s.settings) ?? DEFAULT_LOCAL_API_SETTINGS;
  const updateSettings = useAppStore((s) => s.updateSettings);
  const downloadedModels = useAppStore((s) => s.downloadedModels) ?? [];
  const downloadedImageModels = useAppStore((s) => s.downloadedImageModels) ?? [];
  const activeModelId = useAppStore((s) => s.activeModelId);
  const activeImageModelId = useAppStore((s) => s.activeImageModelId);
  const [apiServerStatus, setApiServerStatus] = useState(localApiServerService.getStatus());

  useEffect(() => {
    completeChecklistStep('exploredSettings');

  }, []);

  useEffect(() => {
    const unsubscribe = localApiServerService.subscribe(setApiServerStatus);
    localApiServerService.refreshStatus().catch(() => { });
    return unsubscribe;
  }, []);

  const activeTextModel = downloadedModels.find((model) => model.id === activeModelId);
  const activeImageModel = downloadedImageModels.find((model) => model.id === activeImageModelId);
  const trackColor = { false: colors.surfaceLight, true: `${colors.primary}80` };

  const handleSendFeedback = async () => {
    const { downloadedModels: localDownloadedModels, activeModelId: localActiveModelId } = useAppStore.getState();
    const { activeServerId } = useRemoteServerStore.getState();

    const [buildNumber, fsInfo] = await Promise.all([
      DeviceInfo.getBuildNumber(),
      RNFS.getFSInfo(),
    ]);

    const ramGB = hardwareService.getTotalMemoryGB().toFixed(1);
    const tier = hardwareService.getDeviceTier();
    const freeGB = (fsInfo.freeSpace / (1024 * 1024 * 1024)).toFixed(1);
    const activeModel = localDownloadedModels.find(m => m.id === localActiveModelId);
    const modelLine = activeModel ? activeModel.fileName : 'None';
    const remoteServer = activeServerId ? 'Yes' : 'No';
    const deviceLine = deviceInfo
      ? `Device: ${deviceInfo.deviceModel} (${deviceInfo.systemName} ${deviceInfo.systemVersion})`
      : 'Device: Unknown';

    const subject = encodeURIComponent(`[Feedback] Off Grid v${packageJson.version}`);
    const body = encodeURIComponent(
      `Hi,\n\n[Describe your feedback or issue here]\n\n` +
      `---\n` +
      `App: v${packageJson.version} (build ${buildNumber})\n` +
      `${deviceLine}\n` +
      `RAM: ${ramGB} GB · Tier: ${tier}\n` +
      `Model: ${modelLine}\n` +
      `Free storage: ${freeGB} GB\n` +
      `Remote server: ${remoteServer}`,
    );
    const url = `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`;
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert(
        'Could Not Open Mail',
        `Looks like there was an issue. You can reach out to us at ${FEEDBACK_EMAIL}`,
        [{ text: 'OK' }],
      );
    }
  };

  const handleResetOnboarding = () => {
    setOnboardingComplete(false);
    // Navigate to root stack and reset to Onboarding
    // getParent() reaches the RootStack from inside the Tab navigator
    navigation.getParent()?.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [{ name: 'Onboarding' }],
      })
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>

        {/* Theme Selector */}
        <AnimatedEntry index={0} staggerMs={40} trigger={focusTrigger}>
          <View style={styles.themeToggleRow}>
            <Text style={styles.themeToggleLabel}>Appearance</Text>
            <View style={styles.themeSelector}>
              {([
                { mode: 'system' as const, icon: 'monitor' },
                { mode: 'light' as const, icon: 'sun' },
                { mode: 'dark' as const, icon: 'moon' },
              ]).map(({ mode, icon }) => (
                <TouchableOpacity
                  key={mode}
                  style={[
                    styles.themeSelectorOption,
                    themeMode === mode && styles.themeSelectorOptionActive,
                  ]}
                  onPress={() => setThemeMode(mode)}
                >
                  <Icon
                    name={icon}
                    size={16}
                    color={themeMode === mode ? colors.background : colors.textMuted}
                  />
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </AnimatedEntry>

        {/* Navigation Items */}
        <AttachStep index={5} fill>
          <View style={styles.navSection}>
            {[
              { icon: 'sliders', title: 'Model Settings', desc: 'System prompt, generation, and performance', screen: 'ModelSettings' as const },
              { icon: 'wifi', title: 'Remote Servers', desc: 'Connect to Ollama, LM Studio, and more', screen: 'RemoteServers' as const },
            //  { icon: 'search', title: 'Web Search', desc: 'Configure search API key for reliable results', screen: 'WebSearchSettings' as const },
              { icon: 'mic', title: 'Voice Transcription', desc: 'On-device speech to text', screen: 'VoiceSettings' as const },
              { icon: 'lock', title: 'Security', desc: 'Passphrase and app lock', screen: 'SecuritySettings' as const },
              { icon: 'smartphone', title: 'Device Information', desc: 'Hardware and compatibility', screen: 'DeviceInfo' as const },
              { icon: 'hard-drive', title: 'Storage', desc: 'Models and data usage', screen: 'StorageSettings' as const },
            ].map((item, index, arr) => (
              <AnimatedListItem
                key={item.screen}
                index={index + 1}
                staggerMs={40}
                trigger={focusTrigger}
                style={[styles.navItem, index === arr.length - 1 && styles.navItemLast]}
                onPress={() => navigation.navigate(item.screen)}
              >
                <View style={styles.navItemIcon}>
                  <Icon name={item.icon} size={16} color={colors.textSecondary} />
                </View>
                <View style={styles.navItemContent}>
                  <Text style={styles.navItemTitle}>{item.title}</Text>
                  <Text style={styles.navItemDesc}>{item.desc}</Text>
                </View>
                <Icon name="chevron-right" size={16} color={colors.textMuted} />
              </AnimatedListItem>
            ))}
          </View>
        </AttachStep>

        {Platform.OS === 'android' && (
          <AnimatedEntry index={6} staggerMs={40} trigger={focusTrigger}>
            <Card style={styles.section}>
              <View style={styles.apiToggleRow}>
                <View style={styles.apiToggleInfo}>
                  <Text style={styles.apiTitle}>LAN API Server</Text>
                  <Text style={styles.apiDesc}>
                    Expose downloaded local text and image models over your Wi-Fi as OpenAI-compatible `/v1` endpoints.
                  </Text>
                </View>
                <Switch
                  value={settings.localApiServerEnabled}
                  onValueChange={(value) => updateSettings({ localApiServerEnabled: value })}
                  trackColor={trackColor}
                  thumbColor={settings.localApiServerEnabled ? colors.primary : colors.textMuted}
                />
              </View>

              <View style={styles.apiMetaRow}>
                <Text style={styles.apiMetaLabel}>Status</Text>
                <Text style={[styles.apiMetaValue, apiServerStatus.isRunning && styles.apiMetaValueActive]}>
                  {settings.localApiServerEnabled
                    ? apiServerStatus.isRunning
                      ? 'Running'
                      : apiServerStatus.lastError
                        ? 'Error'
                        : 'Starting...'
                    : 'Off'}
                </Text>
              </View>
              <View style={styles.apiMetaRow}>
                <Text style={styles.apiMetaLabel}>Port</Text>
                <Text style={styles.apiMetaValue}>{settings.localApiServerPort}</Text>
              </View>
              <View style={styles.apiMetaRow}>
                <Text style={styles.apiMetaLabel}>Models</Text>
                <Text style={styles.apiMetaValue}>
                  {downloadedModels.length} text, {downloadedImageModels.length} image
                </Text>
              </View>

              {settings.localApiServerEnabled && (
                <>
                  <Text selectable style={styles.apiCodeLine}>
                    {apiServerStatus.endpoint ? `${apiServerStatus.endpoint}/v1` : 'Waiting for LAN address...'}
                  </Text>
                  <Text selectable style={styles.apiCodeLine}>
                    API key: {settings.localApiServerApiKey}
                  </Text>
                  <Text style={styles.apiNote}>
                    Chat uses the requested local text model or falls back to the active one. Images use `/v1/images/generations`.
                  </Text>
                  <Text style={styles.apiNote}>
                    Active text: {activeTextModel?.name || 'None selected'} · Active image: {activeImageModel?.name || 'None selected'}
                  </Text>
                  <Text style={styles.apiNote}>
                    The server stays available while the Android app process is alive.
                  </Text>
                </>
              )}

              {apiServerStatus.lastError ? (
                <Text style={styles.apiErrorText}>{apiServerStatus.lastError}</Text>
              ) : null}
            </Card>
          </AnimatedEntry>
        )}

        {/* Community */}
        <AnimatedEntry index={7} staggerMs={40} trigger={focusTrigger}>
          <View style={styles.navSection}>
            <TouchableOpacity style={styles.navItem} onPress={() => Linking.openURL(GITHUB_URL)}>
              <View style={styles.navItemIcon}>
                <Icon name="star" size={16} color={colors.textSecondary} />
              </View>
              <View style={styles.navItemContent}>
                <Text style={styles.navItemTitle}>Star on GitHub</Text>
                <Text style={styles.navItemDesc}>Support the open-source project</Text>
              </View>
              <Icon name="external-link" size={14} color={colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.navItem} onPress={handleSendFeedback}>
              <View style={styles.navItemIcon}>
                <Icon name="mail" size={16} color={colors.textSecondary} />
              </View>
              <View style={styles.navItemContent}>
                <Text style={styles.navItemTitle}>Send Feedback</Text>
                <Text style={styles.navItemDesc}>Report a bug or share a suggestion</Text>
              </View>
              <Icon name="external-link" size={14} color={colors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity style={[styles.navItem, styles.navItemLast]} onPress={() => Linking.openURL(SHARE_ON_X_URL)}>
              <View style={styles.navItemIcon}>
                <Icon name="share-2" size={16} color={colors.textSecondary} />
              </View>
              <View style={styles.navItemContent}>
                <Text style={styles.navItemTitle}>Share on X</Text>
                <Text style={styles.navItemDesc}>Tell others about Off Grid</Text>
              </View>
              <Icon name="external-link" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </AnimatedEntry>

        {/* About */}
        <AnimatedEntry index={8} staggerMs={40} trigger={focusTrigger}>
          <Card style={styles.section}>
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>Version</Text>
              <Text style={styles.aboutValue}>{packageJson.version}</Text>
            </View>
            <Text style={styles.aboutText}>
              Off Grid brings AI to your device without compromising your privacy.
            </Text>
          </Card>
        </AnimatedEntry>

        {/* Privacy */}
        <AnimatedEntry index={9} staggerMs={40} trigger={focusTrigger}>
          <Card style={styles.privacyCard}>
            <View style={styles.privacyIconContainer}>
              <Icon name="shield" size={18} color={colors.textSecondary} />
            </View>
            <Text style={styles.privacyTitle}>Privacy First</Text>
            <Text style={styles.privacyText}>
              {settings.localApiServerEnabled
                ? 'LAN API mode is enabled. Your data still stays on your device, but clients on your local network can access the exposed endpoints with the API key shown above.'
                : 'All your data stays on this device. No conversations, prompts, or personal information is ever sent to any server.'}
            </Text>
          </Card>
        </AnimatedEntry>

        {/* Reset Onboarding */}
        <AnimatedEntry index={10} staggerMs={40} trigger={focusTrigger}>
          <View style={styles.devButtonGroup}>
            <TouchableOpacity style={styles.devButton} onPress={handleResetOnboarding}>
              <Icon name="rotate-ccw" size={14} color={colors.textMuted} />
              <Text style={styles.devButtonText}>Reset Onboarding</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.devButton} onPress={resetChecklist}>
              <Icon name="list" size={14} color={colors.textMuted} />
              <Text style={styles.devButtonText}>Reset Onboarding Checklist</Text>
            </TouchableOpacity>
          </View>
        </AnimatedEntry>
        <MadeWithLove />
      </ScrollView>
    </SafeAreaView>
  );
};

const createStyles = (colors: ThemeColors, shadows: ThemeShadows) => ({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const,
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md, minHeight: 60,
    borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface, ...shadows.small, zIndex: 1,
  },
  title: { ...TYPOGRAPHY.h2, color: colors.text },
  scrollView: { flex: 1 },
  content: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.lg, paddingBottom: SPACING.xxl },
  themeToggleRow: {
    flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const,
    backgroundColor: colors.surface, borderRadius: 8, padding: SPACING.md, marginBottom: SPACING.lg, ...shadows.small,
  },
  themeToggleLabel: { ...TYPOGRAPHY.body, color: colors.text },
  themeSelector: { flexDirection: 'row' as const, backgroundColor: colors.surfaceLight, borderRadius: 8, padding: 3, gap: 2 },
  themeSelectorOption: { width: 34, height: 30, borderRadius: 6, alignItems: 'center' as const, justifyContent: 'center' as const },
  themeSelectorOptionActive: { backgroundColor: colors.primary },
  navSection: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    marginBottom: SPACING.lg,
    overflow: 'hidden' as const,
    ...shadows.small,
  },
  navItem: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    padding: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  navItemLast: { borderBottomWidth: 0 },
  navItemIcon: {
    width: 28, height: 28, borderRadius: 6, backgroundColor: 'transparent',
    alignItems: 'center' as const, justifyContent: 'center' as const, marginRight: SPACING.md,
  },
  navItemContent: { flex: 1 },
  navItemTitle: { ...TYPOGRAPHY.body, fontWeight: '400' as const, color: colors.text },
  navItemDesc: { ...TYPOGRAPHY.bodySmall, color: colors.textMuted, marginTop: 2 },
  section: { marginBottom: SPACING.lg },
  apiToggleRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    marginBottom: SPACING.md,
  },
  apiToggleInfo: { flex: 1, marginRight: SPACING.md },
  apiTitle: { ...TYPOGRAPHY.body, color: colors.text },
  apiDesc: { ...TYPOGRAPHY.bodySmall, color: colors.textMuted, marginTop: 4, lineHeight: 18 },
  apiMetaRow: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    paddingVertical: SPACING.xs,
  },
  apiMetaLabel: { ...TYPOGRAPHY.bodySmall, color: colors.textSecondary },
  apiMetaValue: { ...TYPOGRAPHY.bodySmall, color: colors.text, fontWeight: '500' as const },
  apiMetaValueActive: { color: colors.primary },
  apiCodeLine: {
    ...TYPOGRAPHY.bodySmall,
    color: colors.text,
    backgroundColor: colors.surfaceLight,
    borderRadius: 6,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    marginTop: SPACING.sm,
  },
  apiNote: { ...TYPOGRAPHY.bodySmall, color: colors.textMuted, marginTop: SPACING.sm, lineHeight: 18 },
  apiErrorText: { ...TYPOGRAPHY.bodySmall, color: colors.error, marginTop: SPACING.sm, lineHeight: 18 },
  aboutRow: {
    flexDirection: 'row' as const, justifyContent: 'space-between' as const,
    alignItems: 'center' as const, marginBottom: SPACING.sm,
  },
  aboutLabel: { ...TYPOGRAPHY.body, color: colors.textSecondary },
  aboutValue: { ...TYPOGRAPHY.body, fontWeight: '400' as const, color: colors.text },
  aboutText: { ...TYPOGRAPHY.bodySmall, color: colors.textMuted, lineHeight: 18 },
  privacyCard: { alignItems: 'center' as const, backgroundColor: colors.surface },
  privacyIconContainer: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: 'transparent',
    alignItems: 'center' as const, justifyContent: 'center' as const, marginBottom: SPACING.md,
  },
  privacyTitle: { ...TYPOGRAPHY.h3, color: colors.text, marginBottom: SPACING.sm },
  privacyText: { ...TYPOGRAPHY.body, color: colors.textSecondary, textAlign: 'center' as const, lineHeight: 20 },
  devButton: {
    flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const,
    gap: SPACING.sm, paddingVertical: SPACING.md, marginTop: SPACING.lg,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' as const, borderRadius: 6,
  },
  devButtonGroup: { gap: 12 },
  devButtonText: { ...TYPOGRAPHY.bodySmall, color: colors.textMuted },
});
