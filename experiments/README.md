# 개별 해시 조회 시험

현재 상태: 모의 조회 테스트 4개 통과. 실제 Google 계정 조회는 인증과 표본 파일이 없어 미실행입니다.

Windows PC에서 Python 3.11 이상으로 실행합니다. 이미 백업한 원본 사진 하나, 그 파일을 복사해 이름만 바꾼 사본 하나, 아직 해당 계정에 업로드하지 않은 사진 하나를 준비합니다. 자동 백업 대상 밖에 시험 파일을 보관합니다.

먼저 네트워크 요청 없이 표본을 확인합니다:

```powershell
py experiments/hash_probe.py --original "C:\Photos\original.jpg" --renamed "C:\Photos\renamed.jpg" --new "C:\Photos\new.jpg"
```

실계정 조회에는 별도 `gpmc` 설치와 해당 도구가 사용하는 모바일 API 인증이 필요합니다. 일반 브라우저 로그인이나 공식 Photos API 키로 대체할 수 없습니다. 기존에 정상 구성한 환경에서만 다음을 진행합니다. 인증 값은 채팅·Git·로그에 넣지 않고 해당 PC의 로컬 프로세스 환경변수 `GP_AUTH_DATA`로 공급합니다. 이 시험 도구는 인증정보 추출이나 변조 앱 설치를 자동화하지 않습니다.

```powershell
py experiments/hash_probe.py --original "C:\Photos\original.jpg" --renamed "C:\Photos\renamed.jpg" --new "C:\Photos\new.jpg" --live
```

소스에서 확인한 `gpmc.Client.get_media_key_by_hash()`만 호출합니다. 원본·사본은 동일한 포토 식별자로 발견되고 새 사진은 미발견이어야 표본의 기대 결과와 일치합니다. 오류는 미발견과 별도로 표시합니다. 업로드·삭제 함수는 호출하지 않습니다.

이 실험은 비공식 API가 해당 계정에서 동작하는지 검증하기 위한 것입니다. 조회 성공은 현재 클라우드 파일의 바이트 무결성·원본 화질·휴지통 여부를 보증하지 않습니다. 수정·압축된 사진 및 다른 계정의 사진은 별도 검증이 필요합니다.

테스트: `py -m unittest discover -s experiments -p "test_*.py" -v`
