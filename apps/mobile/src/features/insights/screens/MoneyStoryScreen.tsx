import { useLocalSearchParams, useRouter } from 'expo-router';
import { BookOpen, Pause, Play, Share2, X } from '@/components/icons';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Pressable, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Skeleton,
  SkeletonGroup,
  Text,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import { useRepoQuery } from '@/lib/query';
import { canShareImage, shareViewAsImage } from '@/lib/share';
import { useBalancesHidden } from '@/stores';
import { useTheme } from '@/theme';

import { StoryProgress } from '../components/StoryProgress';
import { StoryShareCard } from '../components/StoryShareCard';
import { StorySlideView } from '../components/StorySlideView';
import { useStoryPlayer } from '../hooks/useStoryPlayer';
import { monthYearLabel } from '../insights';
import { shareSummary, shareText } from '../story';

/** Auto-advancing content must be pausable (WCAG 2.2.2); with a screen reader it never runs on its own. */
function useScreenReader() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setOn);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => sub.remove();
  }, []);
  return on;
}

/**
 * Monthly Money Story (INS-5): a finished month told in story slides that move
 * on by themselves (tap the sides to skip, hold or the button to pause), and a
 * privacy-safe card to share at the end.
 */
export function MoneyStoryScreen() {
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { colors, spacing } = useTheme();
  const { t } = useTranslation();
  const hidden = useBalancesHidden();
  const screenReader = useScreenReader();
  const { month } = useLocalSearchParams<{ month?: string }>();
  const q = useRepoQuery('insights', 'getMoneyStory', { query: month ? { month } : {} });
  const story = q.data;
  const slides = story?.slides ?? [];
  const player = useStoryPlayer(slides.length, !screenReader);
  const card = useRef<ComponentRef<typeof View>>(null);
  const [sharing, setSharing] = useState(false);
  const slide = slides[player.index];
  const isLast = player.index === slides.length - 1;
  const close = () => router.back();

  const share = async () => {
    if (!story) return;
    const summary = shareSummary(story);
    setSharing(true);
    try {
      if (canShareImage)
        await shareViewAsImage(card, t('insights.story.myWithNem', { month: summary.month }));
      else await Share.share({ message: shareText(summary) });
    } catch {
      toast.show({ message: t('insights.story.shareFailed'), tone: 'error' });
    } finally {
      setSharing(false);
    }
  };

  let body;
  if (q.isError && !story) {
    body =
      isApiError(q.error) && q.error.status === 404 ? (
        <EmptyState
          icon={BookOpen}
          title={t('insights.story.noneTitle')}
          message={t('insights.story.noneMessage')}
          actionLabel={t('common.close')}
          onAction={close}
        />
      ) : (
        <ErrorState title={t('insights.story.failed')} onRetry={() => q.refetch()} />
      );
  } else if (!story || !slide) {
    body = (
      <SkeletonGroup accessibilityLabel={t('insights.story.loading')}>
        <Skeleton height={72} width={72} radius={36} />
        <Skeleton height={40} width="70%" />
        <Skeleton height={48} />
      </SkeletonGroup>
    );
  } else {
    body = (
      <>
        <View style={styles.stage}>
          <View accessibilityLiveRegion="polite" style={styles.flex}>
            <StorySlideView key={player.index} slide={slide} hidden={hidden} />
          </View>
          {/* Tap zones, like any story: the left third goes back, the rest goes on. */}
          <Pressable
            style={[styles.zone, styles.left]}
            onPress={player.previous}
            onLongPress={() => player.setPaused(true)}
            onPressOut={() => player.paused && !screenReader && player.setPaused(false)}
            accessibilityRole="button"
            accessibilityLabel={t('insights.story.previous')}
            disabled={player.index === 0}
          />
          <Pressable
            style={[styles.zone, styles.right]}
            onPress={player.next}
            onLongPress={() => player.setPaused(true)}
            onPressOut={() => player.paused && !screenReader && player.setPaused(false)}
            accessibilityRole="button"
            accessibilityLabel={t('insights.story.next')}
            disabled={isLast}
          />
        </View>
        {isLast && (
          <View style={{ gap: spacing[3] }}>
            <StoryShareCard ref={card} summary={shareSummary(story)} />
            <Button
              label={t('insights.story.share')}
              icon={Share2}
              loading={sharing}
              onPress={() => void share()}
              accessibilityHint={t('insights.story.shareHint')}
            />
            <Button label={t('common.done')} variant="ghost" onPress={close} />
          </View>
        )}
      </>
    );
  }

  return (
    <View
      style={[
        styles.flex,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + spacing[2],
          paddingBottom: insets.bottom + spacing[4],
          paddingHorizontal: spacing[4],
          gap: spacing[3],
        },
      ]}
    >
      {slides.length > 0 && (
        <StoryProgress count={slides.length} index={player.index} progress={player.progress} />
      )}
      <View style={[styles.row, { gap: spacing[2] }]}>
        <Text variant="label" color="textMuted" style={styles.flex}>
          {story
            ? t('insights.story.titleMonth', { month: monthYearLabel(story.month) })
            : t('insights.story.title')}
        </Text>
        {slides.length > 1 && !isLast && (
          <IconButton
            icon={player.paused || screenReader ? Play : Pause}
            variant="ghost"
            accessibilityLabel={t(player.paused ? 'insights.story.play' : 'insights.story.pause')}
            disabled={screenReader}
            onPress={() => player.setPaused(!player.paused)}
          />
        )}
        <IconButton
          icon={X}
          variant="ghost"
          accessibilityLabel={t('insights.story.close')}
          onPress={close}
        />
      </View>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  stage: { flex: 1 },
  zone: { position: 'absolute', top: 0, bottom: 0 },
  left: { left: 0, width: '33%' },
  right: { right: 0, width: '67%' },
});
