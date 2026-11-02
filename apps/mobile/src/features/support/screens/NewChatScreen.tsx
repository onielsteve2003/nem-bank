import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Button, Chip, Screen, SectionHeader, Text, TextField } from '@/components';
import { isApiError } from '@/data';
import i18n from '@/lib/i18n';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { queryKeys, useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { MESSAGE_MAX, SUBJECT_MAX, TOPICS, type Topic } from '../support';

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? i18n.t('common.offline')
      : (e.problem.detail ?? e.problem.title)
    : i18n.t('common.somethingWrong');

/** Starting a support chat (SUP-1): what it's about and your first message. */
export function NewChatScreen() {
  const { transaction } = useLocalSearchParams<{ transaction?: string }>();
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const start = useRepoMutation('support', 'startConversation', {
    invalidates: [queryKeys.domain('support')],
  });
  const [topic, setTopic] = useState<Topic | null>(transaction ? 'transfer' : null);
  const [custom, setCustom] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();

  const subject = (topic === 'other' ? custom : topic ? t(`support.topics.${topic}`) : '').trim();
  const ready = subject.length > 0 && text.trim().length > 0;

  const send = () => {
    setError(undefined);
    start.mutate(
      {
        body: {
          subject,
          message: text.trim(),
          ...(transaction ? { transaction_id: transaction } : {}),
        },
      },
      {
        onSuccess: (c) => router.replace({ pathname: '/support/[id]', params: { id: c.id } }),
        onError: (e) => setError(message(e)),
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title={t('support.new.title')} />}
      footer={
        <Button
          label={t('common.send')}
          disabled={!ready}
          loading={start.isPending}
          onPress={send}
          fullWidth
        />
      }
      edges={['top', 'bottom']}
    >
      <View style={{ gap: spacing[3] }}>
        <SectionHeader title={t('support.new.about')} />
        <View style={[styles.wrap, { gap: spacing[2] }]}>
          {TOPICS.map((k) => (
            <Chip
              key={k}
              label={t(`support.topics.${k}`)}
              selected={topic === k}
              onPress={() => setTopic(k)}
            />
          ))}
        </View>
        {topic === 'other' && (
          <TextField
            label={t('support.new.subject')}
            value={custom}
            onChangeText={setCustom}
            maxLength={SUBJECT_MAX}
            placeholder={t('support.new.subjectPlaceholder')}
          />
        )}
      </View>
      <TextField
        label={t('support.new.yourMessage')}
        value={text}
        onChangeText={setText}
        multiline
        maxLength={MESSAGE_MAX}
        placeholder={t('support.new.placeholder')}
        help={transaction ? t('support.new.attach') : undefined}
      />
      <Text variant="caption" color="textMuted">
        {t('support.new.replies')}
      </Text>
      {error && (
        <Text variant="bodySmall" color="danger">
          {error}
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
