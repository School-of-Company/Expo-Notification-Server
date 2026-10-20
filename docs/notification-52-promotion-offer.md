# Notification #52 대기 참여 제안 (Application #144)

Application #144의 참여 제안 문자를 보낸다. 승급 완료 안내(#20, `application.program-session.promoted`)와 topic·Redis 키·상태·문구가 모두 다르다. 제안 문자는 "자리가 생겼으니 기한 안에 수락하라"는 안내이며, 이 문자를 보냈다고 신청이 확정되지는 않는다.

## 흐름

1. Kafka `application.promotion-offer.requested` v1 `{version, eventId, offerId, expoId}`를 받는다. Redis `promotion-offer:{notifications}:record:<eventId>`로 중복을 제거한다.
2. 보내기 직전에 Application `POST /internal/promotion-offers/check`로 확인한다.
   - `NOT_CURRENT_OFFER`이면 보고하지 않고 끝낸다.
   - `OUTSIDE_SEND_WINDOW`(09:00~18:00 KST 밖)이거나 `sendWindowEndsAt`이 지났으면 공급자 호출 전에 `SKIPPED`로 끝내고 보고한다. Application이 다음 09:00에 새 eventId로 다시 예약한다.
3. 대표 번호가 없거나 본문이 2000바이트를 넘으면 공급자 호출 없이 `FAILED`로 보고한다.
4. `SENDING`(`attemptId`, `attemptedAt`)을 먼저 저장한 뒤 Solapi `send-many/detail`을 한 번 호출한다(승급 안내와 같은 transport).
   - 접수 성공이면 성공 응답을 받은 시각을 `acceptedAt`으로 저장하고 `ACCEPTED`를 보고한다. Application은 이 시각 + 6시간(마감 상한)을 응답 기한으로 쓴다.
   - 공급자 거절이면 다시 확인한 뒤 재시도하고, 5회째 거절이면 `FAILED`를 보고한다.
   - 접수 여부를 알 수 없으면 `UNKNOWN`을 보고하고 자동으로 다시 보내지 않는다.
   - 크래시나 결과 저장 실패로 `SENDING`에 5분 넘게 남은 레코드는 스케줄러가 `UNKNOWN`(`PROVIDER_ACCEPTANCE_UNKNOWN`)으로 보고한다. 다시 보내지 않는다(#90).
5. `ACCEPTED`는 30초마다 전달 결과를 조회한다. 전달 성공이면 `DELIVERED`, 확정 실패면 `FAILED`를 보고하며, 다시 보내지 않는다.
6. 보고는 `POST /internal/promotion-offers/{offerId}/deliveries`로 한다. 보내지 못한 보고는 레코드의 `report`에 남기고 5초마다 다시 보낸다. 409(다른 결과·새 이벤트)는 재시도하지 않고 운영 확인 로그를 남긴다.

문자의 응답 기한은 `min(attemptedAt + responseHours, hardDeadline)`으로 보여 준다. 실제 기한(접수 시각 기준)보다 늦게 보이는 일은 없다.

## 운영

- 상태 조회: `GET /internal/promotion-offer-notifications/{eventId}`
- 결과 불명 대사: `POST /internal/promotion-offer-notifications/{eventId}/reconciliation {messageId}`. 전달 결과만 확인하며 다시 보내지 않는다. 접수 시각을 추정하지 않으므로 Application의 응답은 열리지 않는다.
- 두 API 모두 `promotionOffer.internalToken`이 필요하다.

## 설정

```yaml
promotionOffer:
  enabled: false # PROMOTION_OFFER_ENABLED
  internalToken: <32자 이상> # PROMOTION_OFFER_INTERNAL_TOKEN
  topic: application.promotion-offer.requested # KAFKA_PROMOTION_OFFER_TOPIC
  groupId: expo-notification-server.promotion-offer # KAFKA_PROMOTION_OFFER_GROUP_ID
  application:
    baseUrl: <Application URL> # PROMOTION_OFFER_APPLICATION_URL
    internalToken: <Application APPLICATION_INTERNAL_TOKEN> # PROMOTION_OFFER_APPLICATION_INTERNAL_TOKEN
```

다른 기능의 토큰으로 대체하지 않는다. 배포 순서와 Application 계약은 Application `docs/promotion-offer.md`를 따른다. Application 제안 기능보다 먼저 배포해도 이벤트가 없으므로 아무것도 보내지 않는다. 실제 Solapi 발송과 Kafka 연동은 검증하지 않았고, 단위 테스트는 가짜 공급자만 사용한다.
