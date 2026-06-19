package main

import (
	"errors"

	"github.com/golang-jwt/jwt/v5"
)

// validateToken 驗證 Router 簽發的入會 JWT：簽章正確、未過期、且 room 相符。
// 若 JWT_SECRET 未設定（jwtSecret == ""），呼叫端會跳過驗證（方便 dev / 測試）。
func validateToken(secret, tokenStr, room string) error {
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(secret), nil
	})
	if err != nil {
		return err
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return errors.New("invalid token")
	}
	if r, _ := claims["room"].(string); r != room {
		return errors.New("token room mismatch")
	}
	return nil
}
